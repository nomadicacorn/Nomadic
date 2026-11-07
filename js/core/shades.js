// 치아 쉐이드 가이드 (VITA classical 및 미백 쉐이드 계열을 참고한 **근사** Lab 값).
// 실제 측색값은 기기·조명에 따라 다르므로 상담용 상대 비교에만 사용한다.
// 시뮬레이션은 "현재 쉐이드 → 목표 쉐이드"의 Lab 차이만큼 사진의 치아 색을 이동시킨다(노출에 강건).

export const SHADES = [
  { id: 'BL1', label: 'BL1 (최대 미백)', L: 84.0, a: -1.0, b: 5.0 },
  { id: 'BL2', label: 'BL2', L: 82.5, a: -0.8, b: 7.0 },
  { id: 'BL3', label: 'BL3', L: 81.0, a: -0.6, b: 9.0 },
  { id: 'B1', label: 'B1', L: 79.0, a: -0.5, b: 12.0 },
  { id: 'A1', label: 'A1', L: 78.0, a: 0.0, b: 14.5 },
  { id: 'B2', label: 'B2', L: 77.0, a: -0.3, b: 17.0 },
  { id: 'D2', label: 'D2', L: 75.0, a: 0.5, b: 14.0 },
  { id: 'A2', label: 'A2', L: 75.5, a: 0.8, b: 18.0 },
  { id: 'C1', label: 'C1', L: 74.0, a: 0.0, b: 14.0 },
  { id: 'C2', label: 'C2', L: 71.0, a: 0.8, b: 17.0 },
  { id: 'D4', label: 'D4', L: 71.0, a: 1.0, b: 19.0 },
  { id: 'A3', label: 'A3', L: 73.0, a: 1.6, b: 21.0 },
  { id: 'D3', label: 'D3', L: 70.5, a: 1.2, b: 17.0 },
  { id: 'B3', label: 'B3', L: 73.0, a: 0.8, b: 24.0 },
  { id: 'A3.5', label: 'A3.5', L: 70.0, a: 2.5, b: 24.0 },
  { id: 'B4', label: 'B4', L: 71.0, a: 1.2, b: 26.0 },
  { id: 'C3', label: 'C3', L: 68.0, a: 1.5, b: 19.0 },
  { id: 'A4', label: 'A4', L: 66.0, a: 3.2, b: 25.0 },
  { id: 'C4', label: 'C4', L: 63.0, a: 2.5, b: 21.0 },
];

export function shadeById(id) {
  return SHADES.find((s) => s.id === id) || SHADES[11];
}

/**
 * 사진 속 평균 치아 색으로 현재 쉐이드를 "추정" (참고용).
 * 사진 노출은 신뢰할 수 없으므로 L 은 약하게, 색상(a,b)은 강하게 반영한다.
 */
export function estimateShade(stats) {
  if (!stats || !stats.area) return shadeById('A3');
  let best = null;
  let bestD = Infinity;
  for (const s of SHADES) {
    if (s.id.startsWith('BL')) continue; // 자연치는 미백 쉐이드로 추정하지 않음
    const d = 0.15 * (s.L - stats.L) ** 2 + 2 * (s.a - stats.a) ** 2 + (s.b - stats.b) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}
