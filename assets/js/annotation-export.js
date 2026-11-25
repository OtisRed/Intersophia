export function annotationExport(library, csrf, api) {
  const section = library.querySelector('[data-export]');
  const open = section.querySelector('[data-export-open]');
  const check = section.querySelector('[data-export-check]');
  const result = section.querySelector('[data-export-result]');
  const fields = section.querySelector('[data-export-fields]');
  const form = fields.querySelector('form');
  const title = form.elements.title;
  const summary = form.elements.summary;
  const choices = section.querySelector('[data-export-choices]');
  const preview = section.querySelector('[data-export-preview]');
  const confirm = section.querySelector('[data-export-confirm]');
  const status = section.querySelector('[data-export-status]');
  let current;
  let proof;
  let busy = false;

  function hideEditor() {
    fields.hidden = true;
    preview.hidden = true;
    preview.querySelector('img').removeAttribute('src');
    proof = null;
  }

  function reset() {
    current = null;
    status.textContent = '';
    section.hidden = true;
    result.hidden = true;
    hideEditor();
  }

  function renderPublication(publication) {
    const pending = ['sending', 'checking'].includes(publication.state);
    result.hidden = !publication.url;
    if (publication.url) result.href = publication.url;
    open.hidden = !current.thread.can_publish || pending || Boolean(publication.url);
    check.hidden = !current.thread.can_publish || !pending;
    if (pending) status.textContent = 'Wynik wysyłki wymaga sprawdzenia.';
    if (publication.state === 'failed') status.textContent = 'GitHub odrzucił wysyłkę. Możesz przygotować ją ponownie.';
  }

  function show(entry, thread) {
    reset();
    current = { entry, thread };
    section.hidden = !thread.can_publish && !thread.publication.url;
    renderPublication(thread.publication);
  }

  async function send(action, payload) {
    if (busy || !current) return;
    const selected = current;
    const fieldsToDisable = [open, check, confirm, form.querySelector('button[type=submit]')];
    payload.set('csrf', csrf);
    busy = true;
    fieldsToDisable.forEach(button => { button.disabled = true; });
    status.textContent = action === 'preview' ? 'Przygotowuję podgląd…' : 'Sprawdzam publikację…';
    try {
      const response = await fetch(`${api}&watek=${selected.entry.id}&publikacja=${action}`, {
        method: 'POST', body: payload,
      });
      const data = await response.json().catch(() => null);
      if (current !== selected) return;
      if (!response.ok || !data) throw new Error(data?.error || 'Nie udało się wykonać tej akcji.');
      status.textContent = '';
      if (action === 'preview') {
        proof = data.proof;
        fields.hidden = true;
        preview.querySelector('[data-export-title]').textContent = data.title;
        preview.querySelector('[data-export-body]').textContent = data.body;
        preview.querySelector('img').src = `${api}&obraz=${selected.entry.id}`;
        preview.hidden = false;
        if (!selected.thread.publication_configured) status.textContent = 'Wysyłka wymaga podpięcia GitHub App.';
      } else {
        hideEditor();
        renderPublication(data);
      }
    } catch (error) {
      if (current === selected) status.textContent = error.message;
    } finally {
      busy = false;
      fieldsToDisable.forEach(button => { button.disabled = false; });
      confirm.disabled = current?.thread.publication_configured !== true;
    }
  }

  open.addEventListener('click', () => {
    title.value = current.entry.comment.trim().split('\n')[0].slice(0, 100);
    summary.value = current.entry.comment;
    choices.replaceChildren(...current.thread.replies.map(reply => {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'reply';
      checkbox.value = reply.id;
      label.append(checkbox, document.createTextNode(reply.comment));
      return label;
    }));
    preview.hidden = true;
    fields.hidden = false;
    title.focus();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    void send('preview', new FormData(form));
  });
  section.querySelector('[data-export-edit]').addEventListener('click', () => {
    preview.hidden = true;
    fields.hidden = false;
    proof = null;
    title.focus();
  });
  confirm.addEventListener('click', () => {
    if (!proof || !current?.thread.publication_configured) return;
    const data = new FormData();
    data.set('proof', proof);
    void send('send', data);
  });
  check.addEventListener('click', () => void send('check', new FormData()));

  return { show, reset };
}
