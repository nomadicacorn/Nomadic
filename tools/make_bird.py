"""파랑새 PNG 스프라이트 생성기 (원본 그림, PIL로 직접 그림).

python3 tools/make_bird.py  ->  app/assets/ 아래에 PNG/ICO 생성
"""
from pathlib import Path
from PIL import Image, ImageDraw

S = 4                      # 슈퍼샘플링 배율 (안티앨리어싱)
W, H = 180, 140            # 최종 프레임 크기
OUT = Path(__file__).resolve().parent.parent / "app" / "assets"

BLUE = (59, 142, 234, 255)
BLUE_DARK = (34, 104, 196, 255)
BLUE_DEEP = (24, 78, 160, 255)
BELLY = (200, 232, 255, 255)
BEAK = (255, 170, 40, 255)
BEAK_DARK = (226, 128, 20, 255)
CHEEK = (255, 150, 170, 200)
PAPER = (255, 251, 238, 255)
PAPER_EDGE = (205, 190, 160, 255)
SEAL = (226, 60, 80, 255)
INK = (30, 34, 48, 255)


def s(*v):
    return [x * S for x in v]


def ell(d, cx, cy, rx, ry, fill, outline=None, width=0):
    d.ellipse(s(cx - rx, cy - ry, cx + rx, cy + ry), fill=fill,
              outline=outline, width=width * S)


def wing_layer(angle):
    """어깨(pivot)를 축으로 회전한 날개 레이어."""
    layer = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    px, py = 78, 70
    # 날개: 어깨에서 왼쪽으로 뻗은 타원 + 깃털 줄무늬
    ell(d, px - 22, py, 28, 14, BLUE_DARK)
    for i, off in enumerate((-30, -40, -48)):
        ell(d, px + off, py + 2 + i * 2, 9, 6, BLUE_DEEP)
    ell(d, px - 14, py - 3, 16, 7, BLUE)
    return layer.rotate(angle, center=(px * S, py * S), resample=Image.BICUBIC)


def bird(angle, letter=True, blink=False):
    img = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 꼬리
    d.polygon(s(42, 74, 8, 56, 14, 72, 6, 86, 44, 86), fill=BLUE_DARK)
    # 발 (살짝 접힌 발)
    for fx in (78, 92):
        d.line(s(fx, 106, fx - 3, 116), fill=BEAK_DARK, width=3 * S)
        d.line(s(fx - 3, 116, fx - 9, 118), fill=BEAK_DARK, width=3 * S)
        d.line(s(fx - 3, 116, fx + 2, 120), fill=BEAK_DARK, width=3 * S)
    # 몸통 + 머리
    ell(d, 80, 80, 44, 32, BLUE)
    ell(d, 108, 56, 28, 26, BLUE)
    # 배
    ell(d, 92, 90, 30, 18, BELLY)
    # 볼
    ell(d, 116, 68, 7, 4, CHEEK)
    # 눈
    if blink:
        d.arc(s(108, 44, 124, 56), 200, 340, fill=INK, width=3 * S)
    else:
        ell(d, 116, 50, 7, 8, (255, 255, 255, 255))
        ell(d, 118, 51, 4.5, 5.5, INK)
        ell(d, 119.5, 48.5, 1.6, 1.6, (255, 255, 255, 255))
    # 머리 깃
    d.polygon(s(98, 32, 104, 20, 108, 31), fill=BLUE)
    d.polygon(s(104, 31, 114, 22, 114, 33), fill=BLUE_DARK)

    # 날개 (회전)
    img = Image.alpha_composite(img, wing_layer(angle))
    d = ImageDraw.Draw(img)

    if letter:
        # 부리에 문 편지 봉투 (살짝 기울임)
        env = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
        e = ImageDraw.Draw(env)
        x0, y0, x1, y1 = 130, 56, 174, 86
        e.rounded_rectangle(s(x0, y0, x1, y1), radius=3 * S, fill=PAPER,
                            outline=PAPER_EDGE, width=2 * S)
        e.line(s(x0 + 1, y0 + 1, (x0 + x1) / 2, y0 + 17, x1 - 1, y0 + 1),
               fill=PAPER_EDGE, width=2 * S, joint="curve")
        cx, cy = (x0 + x1) / 2, y0 + 17
        ell(e, cx, cy, 5, 5, SEAL)
        # 작은 하트 씰
        e.polygon(s(cx - 2.6, cy - 0.6, cx, cy + 2.6, cx + 2.6, cy - 0.6),
                  fill=(255, 220, 225, 255))
        ell(e, cx - 1.3, cy - 1, 1.4, 1.4, (255, 220, 225, 255))
        ell(e, cx + 1.3, cy - 1, 1.4, 1.4, (255, 220, 225, 255))
        env = env.rotate(-8, center=(130 * S, 62 * S), resample=Image.BICUBIC)
        img = Image.alpha_composite(img, env)
        d = ImageDraw.Draw(img)

    # 부리 (봉투 위에 그려서 물고 있는 느낌)
    d.polygon(s(130, 54, 146, 60, 130, 66), fill=BEAK)
    d.line(s(131, 60, 144, 60), fill=BEAK_DARK, width=1 * S)

    return img.resize((W, H), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    angles = {"1": -48, "2": -12, "3": 30}
    for name, a in angles.items():
        bird(a).save(OUT / f"bird-{name}.png")
        bird(a, letter=False).save(OUT / f"bird-empty-{name}.png")
    bird(-12, blink=True).save(OUT / "bird-blink.png")

    # 앱 아이콘: 편지 문 새를 정사각형에 배치
    icon = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    b = bird(-12).resize((W * 256 // 190, H * 256 // 190), Image.LANCZOS)
    icon.alpha_composite(b, ((256 - b.width) // 2, (256 - b.height) // 2 + 6))
    icon.save(OUT / "icon.png")
    icon.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                                      (64, 64), (128, 128), (256, 256)])
    icon.resize((32, 32), Image.LANCZOS).save(OUT / "tray.png")
    print("saved to", OUT)


if __name__ == "__main__":
    main()
