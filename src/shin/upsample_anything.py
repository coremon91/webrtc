"""Adapted Upsample Anything (KAIST) with CPU/CUDA device support.

Upstream: https://github.com/seominseok0429/Upsample-Anything_Pytorch
Paper: Upsample Anything — Seo, Hamilton, Kim (KAIST / MIT / Microsoft)
"""

from __future__ import annotations

import math

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.optim.lr_scheduler import LambdaLR


def get_device(prefer: str | None = None) -> torch.device:
    if prefer:
        return torch.device(prefer)
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _build_offsets(r_max: int, device: torch.device):
    offs = torch.arange(-r_max, r_max + 1, device=device)
    d_y, d_x = torch.meshgrid(offs, offs, indexing="ij")
    return d_y.reshape(-1), d_x.reshape(-1)


def _tanh_bound_pi(raw: torch.Tensor):
    return math.pi * torch.tanh(raw)


def gather_lr_scalar_general(map_lr: torch.Tensor, ui: torch.Tensor, vi: torch.Tensor):
    hl, wl = map_lr.shape[-2:]
    flat = hl * wl
    idx = (ui * wl + vi).reshape(-1)
    t = map_lr.view(flat)
    vals = t.index_select(0, idx)
    return vals.view(ui.shape[0], ui.shape[1], ui.shape[2])


def gs_jbu_aniso_noparent(
    feat_lr: torch.Tensor,
    guide_hr: torch.Tensor,
    scale: int,
    sigma_x_map: torch.Tensor,
    sigma_y_map: torch.Tensor,
    theta_map: torch.Tensor,
    sigma_r_map: torch.Tensor,
    r_max: int = 4,
    alpha_dyn: float = 2.0,
    c_chunk: int = 512,
    nn_chunk: int = 81,
    center_mode: str = "nearest",
    use_autocast: bool = True,
):
    _, c, hl, wl = feat_lr.shape
    _, _, hh, wh = guide_hr.shape
    dev = feat_lr.device
    dtype_feat = feat_lr.dtype
    dtype_acc = torch.float32

    y = torch.arange(hh, device=dev, dtype=torch.float32)
    x = torch.arange(wh, device=dev, dtype=torch.float32)
    yy, xx = torch.meshgrid(y, x, indexing="ij")

    u = (yy + 0.5) / scale - 0.5
    v = (xx + 0.5) / scale - 0.5

    if center_mode == "nearest":
        uc = torch.round(u).clamp(0, hl - 1).to(torch.long)
        vc = torch.round(v).clamp(0, wl - 1).to(torch.long)
    elif center_mode == "floor":
        uc = torch.floor(u).clamp(0, hl - 1).to(torch.long)
        vc = torch.floor(v).clamp(0, wl - 1).to(torch.long)
    else:
        raise ValueError("center_mode must be 'nearest' or 'floor'")

    sigma_eff = torch.maximum(sigma_x_map, sigma_y_map)
    sigma_eff_hr = F.interpolate(sigma_eff, (hh, wh), mode="bilinear", align_corners=False)
    r_map = torch.ceil(alpha_dyn * sigma_eff_hr).clamp_(min=1, max=r_max).to(torch.int64)

    d_y_all, d_x_all = _build_offsets(r_max, dev)
    k = d_y_all.numel()

    num_s = torch.zeros(c, hh, wh, device=dev, dtype=dtype_acc)
    den_s = torch.zeros(hh, wh, device=dev, dtype=dtype_acc)
    m = torch.full((hh, wh), float("-inf"), device=dev, dtype=dtype_acc)

    guide32 = guide_hr.to(torch.float32, copy=False)
    sx_map32 = sigma_x_map.to(torch.float32, copy=False)
    sy_map32 = sigma_y_map.to(torch.float32, copy=False)
    th_map32 = theta_map.to(torch.float32, copy=False)
    sr_map32 = sigma_r_map.to(torch.float32, copy=False)

    flat = hl * wl
    feat_flat = feat_lr[0].permute(1, 2, 0).reshape(flat, c).contiguous()
    guide_lr = F.interpolate(guide32, size=(hl, wl), mode="bilinear", align_corners=False)

    use_cuda_amp = use_autocast and guide_hr.is_cuda
    autocast_ctx = (
        torch.cuda.amp.autocast(enabled=True, dtype=torch.float16)
        if use_cuda_amp
        else torch.autocast(device_type=guide_hr.device.type, enabled=False)
    )

    with autocast_ctx:
        for n0 in range(0, k, nn_chunk):
            n1 = min(n0 + nn_chunk, k)
            d_y = d_y_all[n0:n1].view(-1, 1, 1)
            d_x = d_x_all[n0:n1].view(-1, 1, 1)
            bn = d_y.shape[0]

            ui = torch.clamp(uc.unsqueeze(0) + d_y, 0, hl - 1)
            vi = torch.clamp(vc.unsqueeze(0) + d_x, 0, wl - 1)

            rad2 = d_y**2 + d_x**2
            mask = (rad2 <= (r_map**2)).squeeze(0).squeeze(0)

            cy = (ui.to(torch.float32) + 0.5) * scale - 0.5
            cx = (vi.to(torch.float32) + 0.5) * scale - 0.5
            dx = xx.unsqueeze(0) - cx
            dy = yy.unsqueeze(0) - cy

            sx = gather_lr_scalar_general(sx_map32, ui, vi).clamp_min(1e-6)
            sy = gather_lr_scalar_general(sy_map32, ui, vi).clamp_min(1e-6)
            th = gather_lr_scalar_general(th_map32, ui, vi)
            sr = gather_lr_scalar_general(sr_map32, ui, vi).clamp_min(1e-6)

            cos_t, sin_t = torch.cos(th), torch.sin(th)
            x_p = dx * cos_t + dy * sin_t
            y_p = -dx * sin_t + dy * cos_t
            log_ws = -(x_p**2) / (2 * sx**2 + 1e-8) - (y_p**2) / (2 * sy**2 + 1e-8)

            g0 = gather_lr_scalar_general(guide_lr[0, 0, ...], ui, vi)
            g1 = gather_lr_scalar_general(guide_lr[0, 1, ...], ui, vi)
            g2 = gather_lr_scalar_general(guide_lr[0, 2, ...], ui, vi)
            diff2 = (
                (guide32[0, 0] - g0) ** 2
                + (guide32[0, 1] - g1) ** 2
                + (guide32[0, 2] - g2) ** 2
            )
            log_wr = -diff2 / (2.0 * sr * sr + 1e-8)

            log_w = log_ws + log_wr
            log_w = torch.where(mask, log_w, torch.full_like(log_w, float("-inf")))

            m_chunk = torch.max(log_w, dim=0).values
            valid = torch.isfinite(m_chunk)
            if not valid.any():
                continue

            m_new = m.clone()
            m_new[valid] = torch.maximum(m[valid], m_chunk[valid])

            delta = (m - m_new).clamp_max(0)
            scale_old = torch.ones_like(den_s)
            scale_old[valid] = torch.exp(delta[valid])
            den_s.mul_(scale_old)
            num_s.mul_(scale_old.unsqueeze(0))

            log_w_shift = log_w - m_new.unsqueeze(0)
            log_w_shift[:, ~valid] = float("-inf")
            s = torch.exp(log_w_shift)

            den_s.add_(s.sum(0))

            idx_flat = (ui * wl + vi).reshape(-1)
            for c0 in range(0, c, c_chunk):
                c1 = min(c0 + c_chunk, c)
                feat_sel = feat_flat.index_select(0, idx_flat)[:, c0:c1]
                feat_sel = feat_sel.view(bn, hh, wh, c1 - c0)
                num_s[c0:c1].add_((feat_sel * s[..., None]).sum(dim=0).permute(2, 0, 1))

            m = m_new

    out_raw = (num_s / den_s.clamp_min(1e-8)).unsqueeze(0).to(dtype_feat)
    fallback = F.interpolate(feat_lr, size=(hh, wh), mode="bilinear", align_corners=False)
    tiny = (den_s < 1e-6).unsqueeze(0).unsqueeze(0)
    return torch.where(tiny, fallback, out_raw)


class LearnablePixelwiseAnisoJBU(nn.Module):
    def __init__(
        self,
        hl: int,
        wl: int,
        scale: int = 16,
        init_sigma: float = 16.0,
        init_sigma_r: float = 0.12,
        r_max: int = 8,
        alpha_dyn: float = 2.0,
        center_mode: str = "nearest",
        eval_c_chunk: int = 128,
        eval_nn_chunk: int = 49,
        use_autocast: bool = True,
    ):
        super().__init__()
        self.scale = int(scale)
        self.r_max = int(r_max)
        self.alpha_dyn = float(alpha_dyn)
        self.center_mode = center_mode
        self.eval_c_chunk = int(eval_c_chunk)
        self.eval_nn_chunk = int(eval_nn_chunk)
        self.use_autocast = bool(use_autocast)

        self.sx_raw = nn.Parameter(
            torch.full((1, 1, hl, wl), float(np.log(init_sigma)), dtype=torch.float32)
        )
        self.sy_raw = nn.Parameter(
            torch.full((1, 1, hl, wl), float(np.log(init_sigma)), dtype=torch.float32)
        )
        self.th_raw = nn.Parameter(torch.zeros((1, 1, hl, wl), dtype=torch.float32))
        self.sr_raw = nn.Parameter(
            torch.full((1, 1, hl, wl), float(np.log(init_sigma_r)), dtype=torch.float32)
        )

    def forward(self, feat_lr: torch.Tensor, guide_hr: torch.Tensor):
        sigma_x = torch.exp(self.sx_raw)
        sigma_y = torch.exp(self.sy_raw)
        theta = _tanh_bound_pi(self.th_raw)
        sigma_r = torch.exp(self.sr_raw)

        c = int(feat_lr.shape[1])
        k = int((2 * self.r_max + 1) * (2 * self.r_max + 1))
        if self.training:
            c_chunk = c
            nn_chunk = k
        else:
            c_chunk = min(self.eval_c_chunk, c)
            nn_chunk = min(self.eval_nn_chunk, k)

        return gs_jbu_aniso_noparent(
            feat_lr,
            guide_hr,
            self.scale,
            sigma_x,
            sigma_y,
            theta,
            sigma_r,
            r_max=self.r_max,
            alpha_dyn=self.alpha_dyn,
            c_chunk=c_chunk,
            nn_chunk=nn_chunk,
            center_mode=self.center_mode,
            use_autocast=self.use_autocast,
        )


def upa(
    hr_img_rgb: np.ndarray | torch.Tensor,
    lr_modality: torch.Tensor,
    *,
    device: torch.device | None = None,
    steps: int = 50,
    lr: float = 1e-1,
) -> torch.Tensor:
    """Upsample low-res modality guided by HR RGB image (Upsample Anything TTO).

    Args:
        hr_img_rgb: HxWx3 uint8/float RGB or CHW tensor
        lr_modality: [1,C,Hl,Wl] tensor
        device: torch device
        steps: test-time optimization steps (paper uses ~50 early-stop)
        lr: Adam learning rate
    """
    device = device or get_device()
    if isinstance(hr_img_rgb, np.ndarray):
        hr = torch.from_numpy(np.asarray(hr_img_rgb)).permute(2, 0, 1).unsqueeze(0).float() / 255.0
    else:
        hr = hr_img_rgb.float()
        if hr.ndim == 3:
            hr = hr.unsqueeze(0)
        if hr.max() > 1.5:
            hr = hr / 255.0

    hr = hr.to(device)
    lr_modality = lr_modality.to(device)
    _, _, h, w = hr.shape
    _, _, hl, wl = lr_modality.shape
    scale = max(1, int(round(h / hl)))

    # Ensure HR is exactly scale * LR for the kernel math.
    target_h, target_w = hl * scale, wl * scale
    if (h, w) != (target_h, target_w):
        hr = F.interpolate(hr, size=(target_h, target_w), mode="bicubic", align_corners=False)

    guide_lr = F.interpolate(hr, size=(hl, wl), mode="bicubic", align_corners=False)
    model = LearnablePixelwiseAnisoJBU(hl, wl, scale=scale, use_autocast=hr.is_cuda).to(device)
    model.train()

    opt = torch.optim.Adam(model.parameters(), lr=lr)
    max_steps = max(steps, 1)
    gamma = (1e-9 / lr) ** (1.0 / max(max_steps, 1))
    scheduler = LambdaLR(opt, lr_lambda=lambda step: gamma**step)

    use_amp = hr.is_cuda
    scaler = torch.cuda.amp.GradScaler(enabled=use_amp) if use_amp else None

    for _ in range(max_steps):
        opt.zero_grad(set_to_none=True)
        if use_amp:
            with torch.cuda.amp.autocast(dtype=torch.float16):
                pred = model(guide_lr, hr)
                loss = F.l1_loss(pred, hr)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
        else:
            pred = model(guide_lr, hr)
            loss = F.l1_loss(pred, hr)
            loss.backward()
            opt.step()
        scheduler.step()

    model.eval()
    with torch.inference_mode():
        if use_amp:
            with torch.cuda.amp.autocast(dtype=torch.float16):
                hr_feat = model(lr_modality, hr)
        else:
            hr_feat = model(lr_modality, hr)
    return hr_feat
