// Run this function in an authenticated preview tab on the guide home page.
// It exercises the rendered React handlers, not a copy of their implementation.
export default async function checkGuideInteraction() {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 350));
  const topic = document.querySelector('[data-guide-topic="find-things"]');
  if (!topic) throw new Error("Missing supplies topic");
  const heading = document.querySelector("h1");
  const search = document.querySelector("#guide-search");
  const query = search?.value;
  window.scrollTo(0, 300);
  await pause();
  topic.focus({ preventScroll: true });
  const before = window.scrollY;
  topic.click();
  await pause();
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog?.textContent.includes("linen cupboard"))
    throw new Error("Instructions did not open");
  if (Math.abs(window.scrollY - before) > 1)
    throw new Error(
      `Opening instructions scrolled from ${before} to ${window.scrollY}`,
    );
  const close = document.querySelector('[aria-label="Close instructions"]');
  if (!close) throw new Error("Missing close action");
  close.click();
  await pause();
  if (document.querySelector('[role="dialog"]'))
    throw new Error("Instructions did not close");
  if (Math.abs(window.scrollY - before) > 1)
    throw new Error(
      `Closing instructions scrolled from ${before} to ${window.scrollY}`,
    );
  if (heading !== document.querySelector("h1"))
    throw new Error("Topic click replaced the page");
  if (query !== search?.value)
    throw new Error("Instructions cleared the search");
  if (document.activeElement !== topic)
    throw new Error("Focus did not return to the topic");
  if (location.hash) throw new Error("Closing instructions left a stale link");
  if (document.documentElement.scrollWidth > innerWidth)
    throw new Error("Guide overflows the viewport");
  return "PASS: instructions preserve the viewport, page, search and keyboard focus";
}

export async function checkGuideHistory() {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 350));
  async function expectView(hash, text) {
    const deadline = Date.now() + 3000;
    while (location.hash !== hash && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await pause();
    if (location.hash !== hash) throw new Error(`Expected URL hash ${hash}`);
    const dialog = document.querySelector('[role="dialog"]');
    if (text ? !dialog?.textContent.includes(text) : dialog)
      throw new Error(`History did not restore ${hash || "home"}`);
  }
  if (location.hash)
    throw new Error("Start the history check on the home screen");
  const heading = document.querySelector("h1");
  const before = window.scrollY;
  document.querySelector('[data-guide-topic="find-things"]').click();
  await expectView("#find-things", "linen cupboard");
  history.back();
  await expectView("", undefined);
  history.forward();
  await expectView("#find-things", "linen cupboard");
  document.querySelector('[aria-label="Close instructions"]').click();
  await expectView("", undefined);
  history.forward();
  await expectView("#find-things", "linen cupboard");
  history.back();
  await expectView("", undefined);
  document.querySelector('[aria-label="Ask the guide"]').click();
  await expectView("#chat", "ask AI");
  history.back();
  await expectView("", undefined);
  history.forward();
  await expectView("#chat", "ask AI");
  document.querySelector('[aria-label="Close chat"]').click();
  await expectView("", undefined);
  if (heading !== document.querySelector("h1"))
    throw new Error("History replaced the home page");
  if (Math.abs(window.scrollY - before) > 1)
    throw new Error("History changed the home page scroll position");
  return "PASS: Back, Forward and close restore cards and chat without replacing or scrolling the page";
}
