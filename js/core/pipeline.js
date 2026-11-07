// 치료 시뮬레이션 파이프라인. 순서: 교정(워핑) → 레진 → 라미네이트 표면 → 미백 → 보철 템플릿
// 템플릿 레이어는 캔버스가 필요하므로 renderTemplateLayer 콜백으로 주입한다(테스트 시 생략 가능).

import { cloneImage, applyWhitening, applyResin, applySmoothing, compositeTemplate } from './effects.js';
import { warpMouth } from './ortho.js';
import { shadeById } from './shades.js';

/**
 * @param original ImageData 유사
 * @param seg segmentTeeth 결과
 * @param plan { ortho:{on,strength}, pins:[{sx,sy,tx,ty}], resin:{on,stain,gap}, veneer:{on,smooth},
 *               whitening:{on,from,to,strength}, template:{on,...}, currentShade }
 * @param renderTemplateLayer (params, shade, w, h) => Uint8ClampedArray RGBA
 */
export function runPipeline(original, seg, plan, renderTemplateLayer = null) {
  const out = cloneImage(original);
  let mask = seg.mask;
  const s = { ...seg };

  if (plan.ortho?.on && plan.pins?.length) {
    mask = warpMouth(original, out, seg, plan.pins, plan.ortho.strength);
    s.mask = mask;
  }
  if (plan.resin?.on) {
    mask = applyResin(out, s, plan.resin);
    s.mask = mask;
  }
  if (plan.veneer?.on) applySmoothing(out, mask, seg.bbox, plan.veneer);
  if (plan.whitening?.on) {
    applyWhitening(out, mask, seg.bbox, {
      from: shadeById(plan.whitening.from),
      to: shadeById(plan.whitening.to),
      strength: plan.whitening.strength,
    });
  }
  if (plan.template?.on && renderTemplateLayer) {
    const layer = renderTemplateLayer(plan.template, shadeById(plan.template.shade), out.width, out.height);
    compositeTemplate(out, layer, s, plan.template);
  }
  return { image: out, mask };
}
