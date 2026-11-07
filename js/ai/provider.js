// AI 연동 경계(Adapter). MVP 는 LocalHeuristicProvider(규칙 기반)만 구현되어 있다.
// 향후 AI 모델은 이 인터페이스를 구현해 교체한다. 개인정보 보호를 위해
// **기기 내 추론(on-device: ONNX Runtime Web / TensorFlow.js / MediaPipe)** 을 1순위로 한다.
// 서버 추론이 꼭 필요하면 index.html 의 CSP connect-src 를 해당 도메인으로만 열고,
// 비식별화(입 영역만 크롭) + 전송 동의 + 보관 금지 정책을 함께 적용해야 한다.

import { segmentTeeth, suggestPins } from '../core/segmentation.js';
import { estimateShade } from '../core/shades.js';

export class NotImplementedError extends Error {
  constructor(feature) {
    super(`[AI 미구현] ${feature} — 향후 AI 모델 연동 필요 (docs/FEATURES.md 참고)`);
    this.name = 'NotImplementedError';
    this.feature = feature;
  }
}

/**
 * 기능별 구현 상태. UI 에 그대로 표시된다.
 * status: 'done'(구현됨, 규칙기반) | 'ai'(AI 연동 필요)
 */
export const CAPABILITIES = [
  { key: 'capture', name: '가이드 촬영·카운트다운', status: 'done' },
  { key: 'lip', name: '입술 윤곽 지정', status: 'done', note: '가이드 타원 + 수동 조정' },
  { key: 'seg', name: '치아 영역 분할', status: 'done', note: '색상 통계(Otsu) + 수동 브러시' },
  { key: 'shade', name: '쉐이드 추정', status: 'done', note: '참고용 근사' },
  { key: 'whitening', name: '미백 시뮬레이션', status: 'done' },
  { key: 'resin', name: '레진(착색·틈 메움)', status: 'done' },
  { key: 'veneer', name: '라미네이트 표면 정리', status: 'done' },
  { key: 'template', name: '보철 스마일 템플릿', status: 'done', note: '형태 3종·황금비율' },
  { key: 'ortho', name: '교정 배열(워핑)', status: 'done', note: '핀 자동 제안 + 수동 보정' },
  { key: 'compare', name: '전/후 비교·가이드선', status: 'done' },
  { key: 'landmark', name: '얼굴 랜드마크 자동 검출', status: 'ai' },
  { key: 'instance', name: '치아 개별 분할·치식 번호', status: 'ai' },
  { key: 'genai', name: '사실적 결과 생성(생성형 AI)', status: 'ai' },
  { key: 'diagnosis', name: '부정교합·치료 적합도 판단', status: 'ai' },
  { key: 'face3d', name: '3D 얼굴/구강스캔 연동', status: 'ai' },
];

/** 인터페이스 정의 (JSDoc 용 베이스 클래스) */
export class SmileAIProvider {
  /** 얼굴/입술 랜드마크 → 입술 내측 윤곽 [{x,y}] */
  async detectLipContour(_image) { throw new NotImplementedError('입술 윤곽 자동 검출'); }
  /** 치아 영역 분할 → segmentTeeth 와 같은 형식 */
  async segmentTeeth(_image, _lipPoly, _opts) { throw new NotImplementedError('치아 분할'); }
  /** 치아별 인스턴스 분할 + FDI 치식 번호 → [{fdi, polygon, incisalPoint}] */
  async detectTeethInstances(_image, _seg) { throw new NotImplementedError('치아 개별 분할·번호'); }
  /** 쉐이드 추정 */
  async estimateShade(_image, _seg) { throw new NotImplementedError('쉐이드 추정'); }
  /** 규칙 기반 결과를 사실적으로 다듬는 생성형 리파인(인페인팅) */
  async refineResult(_before, _after, _mask, _plan) { throw new NotImplementedError('생성형 결과 리파인'); }
}

/** MVP 구현: 규칙 기반 영상처리 (네트워크 사용 없음) */
export class LocalHeuristicProvider extends SmileAIProvider {
  async detectLipContour() { throw new NotImplementedError('입술 윤곽 자동 검출 (MVP: 촬영 가이드 + 수동 조정)'); }
  async segmentTeeth(image, lipPoly, opts) { return segmentTeeth(image, lipPoly, opts); }
  async detectTeethInstances(image, seg) {
    // 근사: 마스크 열 프로파일 기반 절단연 추정만 제공 (번호 부여 없음)
    return suggestPins(seg, image).map((p) => ({ fdi: null, polygon: null, incisalPoint: p }));
  }
  async estimateShade(_image, seg) { return estimateShade(seg.stats); }
  async refineResult(_b, after) { return after; }
}

export function createProvider() {
  return new LocalHeuristicProvider();
}
