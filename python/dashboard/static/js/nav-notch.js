'use strict';

// Floating-notch tab indicator for the sidebar nav (the "Floating Notch" tab-bar animation, adapted from a bottom tab bar to this vertical one):
// a ball sits in a ring ("notch") at the right edge of the active tab, and when another tab is chosen it hops there along a short arc.
// The nav is rebuilt from scratch on every render (renderNav in core-ui.js, also on the 5 second refresh), so the ball is recreated each time and
// only animates when the ACTIVE TAB changed since the last render; a re-render of the same tab, or a group expanding, just places it.
// Pure planning functions first (testable from Node), then the one DOM function renderNav calls.

const NAV_NOTCH_MS = 200;      // the canon's motion budget for a UI transition; tab switching is a high-frequency action
const NAV_NOTCH_BALL_PX = 12;
const NAV_NOTCH_HOP_PX = 10;   // how far the ball arcs out toward the page content mid-hop

// Top of the ball (px, in the nav's scrolling content coordinates) so it is vertically centred on the active button.
function navNotchTop(buttonOffsetTop, buttonHeight, ballPx = NAV_NOTCH_BALL_PX) {
  return Math.round(buttonOffsetTop + (buttonHeight - ballPx) / 2);
}

// Keyframes for Element.animate: from the old row to the new one, bulging outward and growing slightly at the midpoint.
function navNotchKeyframes(fromTop, toTop, hopPx = NAV_NOTCH_HOP_PX) {
  const mid = Math.round((fromTop + toTop) / 2);
  return [
    { transform: `translate(0px, ${fromTop}px) scale(1)` },
    { transform: `translate(${hopPx}px, ${mid}px) scale(1.25)`, offset: 0.5 },
    { transform: `translate(0px, ${toTop}px) scale(1)` },
  ];
}

// Decide what to do this render. Animate only when there was a previous position, the active tab changed, the ball actually has to move,
// and the user has not asked for reduced motion.
function navNotchPlan({ lastKey, lastTop, activeKey, newTop, reducedMotion }) {
  const moved = lastTop !== null && lastTop !== undefined && lastTop !== newTop;
  const animate = !reducedMotion && moved && lastKey !== null && lastKey !== undefined && lastKey !== activeKey;
  return { animate, keyframes: animate ? navNotchKeyframes(lastTop, newTop) : null, durationMs: NAV_NOTCH_MS };
}

let navNotchLastKey = null;
let navNotchLastTop = null;

function navNotchReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Called at the end of renderNav(). The horizontal nav on narrow screens keeps its underline, so the notch is hidden there by CSS.
function navNotchUpdate(nav) {
  const active = nav && nav.querySelector ? nav.querySelector('button.active') : null;
  if (!active) return null;
  const key = typeof activeTab !== 'undefined' ? activeTab : '';
  const newTop = navNotchTop(active.offsetTop, active.offsetHeight);
  const ball = document.createElement('span');
  ball.className = 'nav-notch';
  ball.setAttribute('aria-hidden', 'true');
  ball.innerHTML = '<span class="nav-notch-ball"></span>';
  nav.appendChild(ball);
  const plan = navNotchPlan({ lastKey: navNotchLastKey, lastTop: navNotchLastTop, activeKey: key, newTop, reducedMotion: navNotchReducedMotion() });
  ball.style.transform = `translate(0px, ${newTop}px)`;
  if (plan.animate && typeof ball.animate === 'function') ball.animate(plan.keyframes, { duration: plan.durationMs, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  navNotchLastKey = key;
  navNotchLastTop = newTop;
  return plan;
}

if (typeof module !== 'undefined') module.exports = { NAV_NOTCH_MS, NAV_NOTCH_BALL_PX, NAV_NOTCH_HOP_PX, navNotchTop, navNotchKeyframes, navNotchPlan, navNotchUpdate };
