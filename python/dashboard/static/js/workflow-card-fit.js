// Fitting the loop cards to the screen (HUB0346 follow-up, card width). A plain global <script> loaded by index.html after workflow-loops.js and before workflow-graph-view.js.
// DOM code (it reads sizes and sets styles), kept out of the view file so that stays under 500 lines. Uses fitScaleForCard, cardWidthFor, WF_MIN_SCALE and WF_CARD_MIN_W (workflow-loops.js).

const WF_NARROW_PX = 700; // a window this wide or narrower is a phone: one card per screen, swiped; wider screens size each card to its drawing and wrap them

function wfIsNarrow() {
  if (typeof matchMedia === 'function') return matchMedia('(max-width: ' + WF_NARROW_PX + 'px)').matches;
  return typeof window !== 'undefined' && Number.isFinite(window.innerWidth) && window.innerWidth <= WF_NARROW_PX;
}

// Scale every card's canvas to fit its body (never above 1, never below WF_MIN_SCALE; below that the body scrolls). The wrapper takes the scaled size so the scroll area matches what is drawn.
function wfFitCards(main) {
  const narrow = wfIsNarrow();
  main.querySelectorAll('.wf-card').forEach((card) => {
    const body = card.querySelector('.wf-card-body');
    const wrap = card.querySelector('.wf-scale');
    const canvas = card.querySelector('.wf-canvas');
    if (!body || !wrap || !canvas) return;
    const w = Number(canvas.dataset.w);
    const h = Number(canvas.dataset.h);
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(body) : null;
    const pad = (a, b) => (cs ? (parseFloat(cs[a]) || 0) + (parseFloat(cs[b]) || 0) : 0);
    const padX = pad('paddingLeft', 'paddingRight');
    const padY = pad('paddingTop', 'paddingBottom');
    const head = card.querySelector('.wf-card-head');
    // On a wide screen the card is as tall as its drawing (at most 78 % of the window), so the height to fit into is that maximum, not the card's current height.
    const maxH = Math.max(160, Math.round(window.innerHeight * 0.78) - (head ? head.offsetHeight : 0) - padY - 2);
    // A wide screen: the card is as wide as the drawing AS SCALED needs (plus padding, the card border and room for a vertical scrollbar), between WF_CARD_MIN_W and the row, so several
    // cards sit side by side and wrap. A phone: the stylesheet makes it one screen wide (swipe), so any width set earlier is cleared.
    if (narrow) {
      card.style.width = '';
    } else {
      const rowW = card.parentElement ? card.parentElement.clientWidth : 0;
      const extra = padX + 2 + 14;
      const s0 = fitScaleForCard(w, h, Math.max(1, rowW - extra), maxH, WF_MIN_SCALE);
      card.style.width = cardWidthFor(w * s0, rowW, extra, WF_CARD_MIN_W) + 'px';
    }
    const viewH = narrow ? body.clientHeight - padY : maxH;
    const s = fitScaleForCard(w, h, body.clientWidth - padX, viewH, WF_MIN_SCALE);
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = s < 1 ? 'scale(' + s + ')' : '';
    wrap.style.width = Math.ceil(w * s) + 'px';
    wrap.style.height = Math.ceil(h * s) + 'px';
    card.dataset.scale = String(s);
  });
}
