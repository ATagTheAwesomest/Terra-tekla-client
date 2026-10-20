// Phone layout, switched on from the right-hand menu and remembered on this
// device. Its styles (css/mobile.css) all sit under body.layout-mobile, so the
// iPad layout in css/app.css and css/shipping.css stays as it is.

const LAYOUT_KEY = 'terra.layout';

export function isMobile() {
  return document.body.classList.contains('layout-mobile');
}

function applyLayout(mobile) {
  document.body.classList.toggle('layout-mobile', mobile);
  const btn = document.getElementById('btn-layout');
  btn?.setAttribute('aria-pressed', String(mobile));
  const label = document.getElementById('layout-state');
  if (label) label.textContent = mobile ? 'On' : 'Off';
}

// Picks the saved layout, or the phone layout on a phone-sized screen the
// first time. onChange re-renders after the menu toggle.
export function initLayout(onChange) {
  let saved = null;
  try { saved = localStorage.getItem(LAYOUT_KEY); } catch { /* storage blocked */ }
  applyLayout(saved ? saved === 'mobile' : matchMedia('(max-width: 600px)').matches);
  document.getElementById('btn-layout').addEventListener('click', () => {
    const mobile = !isMobile();
    applyLayout(mobile);
    try { localStorage.setItem(LAYOUT_KEY, mobile ? 'mobile' : 'tablet'); } catch { /* storage blocked */ }
    onChange();
  });
}
