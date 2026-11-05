import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { installDom } from './helpers/dom';

const dom = installDom();
const { Editor } = await import('@tiptap/core');
const { editorExtensions } = await import('../src/lib/editor-extensions');
after(() => {
  dom.cleanup();
});

function mount(
  t: TestContext,
  content = '<p></p>',
  includeProfilePaste = true,
) {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: editorExtensions.filter(
      (extension) =>
        includeProfilePaste || extension.name !== 'instagramProfilePaste',
    ),
    content,
  });
  t.after(() => {
    editor.destroy();
    element.remove();
  });
  return editor;
}

function paste(editor: InstanceType<typeof Editor>, text: string, html = '') {
  // Dispatch through EditorView's actual clipboard parser and installed plugins.
  // jsdom has no OS clipboard; the native clipboard journey stays in Playwright.
  const event = new dom.window.Event('paste', {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) =>
        type === 'text/plain' ? text : type === 'text/html' ? html : '',
    },
  });
  editor.view.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
}

// canonicalcaseID: 6c3be3e3961fb6c73daa-aed22ca78228611209fc
for (const text of [
  'https://www.instagram.com/p/ABC/',
  'https://instagram.com/reel/ABC/',
  'https://instagram.com/stories/sample/123/',
  'https://instagram.com/explore/',
  'https://instagram.com.evil.test/sample/',
  'https://evil.test@instagram.com/sample/',
  'https://example.com/sample/',
  'ordinary text',
  'See https://instagram.com/sample/ later',
]) {
  void test(`actual paste plugin preserves non-profile input: ${text}`, (t) => {
    const editor = mount(t);
    paste(editor, text);
    assert.equal(editor.getText(), text);
    assert.equal(
      [...editor.view.dom.querySelectorAll('a')].filter((link) =>
        link.textContent.startsWith('@'),
      ).length,
      0,
    );
  });
}

void test('actual paste plugin preserves rich HTML bold and italic marks', (t) => {
  const editor = mount(t);
  paste(editor, 'Rich text', '<p><strong>Rich</strong> <em>text</em></p>');
  assert.equal(editor.view.dom.querySelector('strong')?.textContent, 'Rich');
  assert.equal(editor.view.dom.querySelector('em')?.textContent, 'text');
});

void test('actual paste plugin preserves rich profile URLs and multiple paragraphs', (t) => {
  const editor = mount(t);
  const url = 'https://instagram.com/sample/';
  paste(editor, url, `<p><strong>${url}</strong></p>`);
  assert.equal(editor.view.dom.querySelector('strong')?.textContent, url);
  editor.commands.clearContent();
  paste(editor, url, `<p>${url}</p><p>keep this paragraph</p>`);
  assert.equal(editor.view.dom.querySelectorAll('p').length, 2);
  assert.ok(editor.getText().includes('keep this paragraph'));
  assert.equal(editor.view.dom.querySelector('p')?.textContent, url);
});

void test('actual paste plugin replaces selection with a canonical link', (t) => {
  const editor = mount(t, '<p>before replace me after</p>');
  editor.commands.setTextSelection({ from: 8, to: 18 });
  paste(editor, 'www.instagram.com/another_sample/');
  assert.equal(editor.getText(), 'before @another_sample after');
  const link = editor.view.dom.querySelector('a');
  assert.ok(link);
  assert.equal(link.textContent, '@another_sample');
  assert.equal(
    link.getAttribute('href'),
    'https://www.instagram.com/another_sample/',
  );
});

void test('actual paste plugin retains active bold italic marks without extending the link', (t) => {
  const editor = mount(t);
  editor.commands.setBold();
  editor.commands.setItalic();
  paste(editor, 'www.instagram.com/another_sample/');
  assert.equal(
    editor.view.dom.querySelector('strong em')?.textContent,
    '@another_sample',
  );
  assert.ok(
    editor.state.storedMarks?.some((mark) => mark.type.name === 'bold'),
  );
  assert.ok(
    editor.state.storedMarks?.some((mark) => mark.type.name === 'italic'),
  );
  assert.equal(
    editor.state.storedMarks?.some((mark) => mark.type.name === 'link'),
    false,
  );
  editor.commands.insertContent(' after');
  assert.equal(
    editor.view.dom.querySelector('a')?.textContent,
    '@another_sample',
  );
  assert.equal(
    [...editor.view.dom.querySelectorAll('strong em')]
      .map((mark) => mark.textContent)
      .join(''),
    '@another_sample after',
  );
});

void test('actual paste plugin opts out of inline code', (t) => {
  const editor = mount(t);
  editor.commands.setCode();
  editor.commands.insertContent('code ');
  editor.view.dispatch(editor.state.tr.setStoredMarks(null));
  assert.equal(editor.state.storedMarks, null);
  assert.ok(
    editor.state.selection.$from.marks().some((mark) => mark.type.spec.code),
  );
  paste(editor, 'https://instagram.com/sample/');
  assert.equal(
    editor.view.dom.querySelector('code')?.textContent,
    'code https://instagram.com/sample/',
  );
  assert.equal(editor.view.dom.querySelectorAll('a').length, 0);
});

void test('actual paste plugin opts out of stored inline code marks', (t) => {
  const editor = mount(t);
  const standard = mount(t, '<p></p>', false);
  editor.commands.setCode();
  standard.commands.setCode();
  assert.ok(editor.state.storedMarks?.some((mark) => mark.type.spec.code));
  paste(editor, 'https://instagram.com/sample/');
  paste(standard, 'https://instagram.com/sample/');
  assert.deepEqual(editor.getJSON(), standard.getJSON());
  assert.equal(editor.getText(), 'https://instagram.com/sample/');
});

for (const selection of [
  { from: 3, to: 11 },
  { from: 11, to: 17 },
]) {
  void test(`actual paste plugin opts out when a selection endpoint is in a code block: ${String(selection.from)}-${String(selection.to)}`, (t) => {
    const editor = mount(
      t,
      '<p>before</p><pre><code>code</code></pre><p>after</p>',
    );
    const standard = mount(
      t,
      '<p>before</p><pre><code>code</code></pre><p>after</p>',
      false,
    );
    editor.commands.setTextSelection(selection);
    standard.commands.setTextSelection(selection);
    assert.ok(
      editor.state.selection.$from.parent.type.spec.code ||
        editor.state.selection.$to.parent.type.spec.code,
    );
    paste(editor, 'https://instagram.com/sample/');
    paste(standard, 'https://instagram.com/sample/');
    assert.deepEqual(editor.getJSON(), standard.getJSON());
    assert.equal(editor.getText().includes('@sample'), false);
  });
}

void test('actual paste plugin opts out of code blocks', (t) => {
  const editor = mount(t, '<pre><code></code></pre>');
  paste(editor, 'https://instagram.com/sample/');
  assert.equal(
    editor.view.dom.querySelector('pre code')?.textContent,
    'https://instagram.com/sample/',
  );
  assert.equal(editor.view.dom.querySelectorAll('a').length, 0);
});
