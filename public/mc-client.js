const toggle = document.querySelector('#auto-refresh');
let edited = false;
document.addEventListener('input', event => { if (event.target !== toggle) edited = true; });
setInterval(() => {
  if (toggle?.checked && !document.hidden && !edited && !document.querySelector('dialog[open], .price-details details[open], #custos[open]') && !['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName)) location.reload();
}, 60000);
document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.open).showModal()));
document.querySelectorAll('.simulator').forEach(form => form.addEventListener('submit', event => {
  event.preventDefault();
  const price = Number(form.elements.preco.value);
  const mc = price * (1 - Number(form.dataset.rate)) - Number(form.dataset.cost) - Number(form.dataset.shipping);
  const money = value => value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  form.querySelector('output').textContent = price > 0 && Number.isFinite(mc) ? `MC estimada: ${money(mc)} · ${(100*mc/price).toFixed(2)}%` : 'Informe um preço válido.';
}));
document.querySelectorAll('input[type="date"]').forEach(input => input.addEventListener('change', () => { document.querySelector('select[name="periodo"]').value = 'custom'; }));
document.querySelectorAll('a[href="#custos"]').forEach(link => link.addEventListener('click', () => { document.querySelector('#custos').open = true; }));
