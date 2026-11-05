"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ArticleContent } from "@/components/article-content";
import { RichEditor } from "@/components/rich-editor";
import { WifiSetup } from "@/components/wifi-access";
import { legacyBody } from "@/lib/guide-migration";
import {
  cmsSnapshotSchema,
  type CmsAction,
  type CmsSnapshot,
  type GuideDocument,
} from "@/lib/guide-cms-types";

type EditableArticle = GuideDocument["articles"][number];

function TextField({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  const style =
    "mt-1 min-h-11 w-full border bg-background p-2 text-sm leading-6 focus-visible:outline-2 focus-visible:outline-primary";
  return (
    <label className="block text-xs leading-6">
      {label}
      {multiline ? (
        <textarea
          className={style}
          rows={3}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          className={style}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function AiNotes({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [text, setText] = useState(values.join("\n"));
  return (
    <TextField
      label="AI notes, one fact per line"
      value={text}
      multiline
      onChange={(value) => {
        setText(value);
        onChange(value.split("\n").filter((line) => line.trim()));
      }}
    />
  );
}

export function GuideEditor({ initial }: { initial: CmsSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [document, setDocument] = useState(initial.state.draft);
  const [topic, setTopic] = useState("home");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const article = document.articles.find((item) => item.id === topic);
  const [richError, setRichError] = useState("");
  const dirty =
    JSON.stringify(document) !== JSON.stringify(snapshot.state.draft);
  const facts =
    document.chatKnowledge.find((item) => item.articleId === topic)?.facts ??
    [];

  function updateArticle(patch: Partial<EditableArticle>) {
    setDocument((current) => ({
      ...current,
      articles: current.articles.map((item) =>
        item.id === topic ? { ...item, ...patch } : item,
      ),
    }));
    setMessage("");
  }
  function updateKnowledge(values: string[]) {
    setDocument((current) => ({
      ...current,
      chatKnowledge: current.chatKnowledge.some(
        (item) => item.articleId === topic,
      )
        ? current.chatKnowledge.map((item) =>
            item.articleId === topic ? { ...item, facts: values } : item,
          )
        : [...current.chatKnowledge, { articleId: topic, facts: values }],
    }));
    setMessage("");
  }
  async function save(action: CmsAction) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/guide", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, etag: snapshot.etag, document }),
      });
      if (!response.ok) throw new Error(await response.text());
      const json: unknown = await response.json();
      const parsed = cmsSnapshotSchema.safeParse(json);
      if (!parsed.success)
        throw new Error(
          "The saved guide could not be loaded. Please reload the editor.",
        );
      const next = parsed.data;
      setSnapshot(next);
      setDocument(next.state.draft);
      setMessage(
        action === "publish"
          ? "Published. Guests and AI chat now use this version."
          : "Draft saved. The published guide is unchanged.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Your changes could not be saved. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-12">
      <header className="sticky top-0 z-10 space-y-4 border-b bg-background py-5">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-lg">edit guide</h1>
          <a
            href="/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs underline"
          >
            view guide
          </a>
        </div>
        <label className="block text-xs">
          topic
          <select
            className="mt-1 min-h-11 w-full border bg-background p-2 text-sm"
            value={topic}
            disabled={busy}
            onChange={(event) => {
              setTopic(event.target.value);
              setRichError("");
              setMessage("");
            }}
          >
            <option value="home">Apartment & contact details</option>
            {document.articles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setPreview((current) => !current)}
          >
            {preview ? "edit text" : "preview"}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !snapshot.canSave || Boolean(richError)}
            onClick={() => save("save")}
          >
            {busy ? "saving…" : "save draft"}
          </Button>
          <Button
            disabled={busy || !snapshot.canSave || Boolean(richError)}
            onClick={() => save("publish")}
          >
            publish
          </Button>
        </div>
        <p className="text-xs" role="status">
          {richError ||
            message ||
            (dirty
              ? "unsaved changes"
              : JSON.stringify(snapshot.state.draft) ===
                    JSON.stringify(snapshot.state.published) &&
                  snapshot.state.publishedAt
                ? "published version"
                : snapshot.state.savedAt
                  ? "saved draft"
                  : "ready to edit")}
        </p>
        {!snapshot.canSave && (
          <p className="text-xs">Saving is unavailable in this environment.</p>
        )}
      </header>
      <fieldset disabled={busy} className="min-w-0 w-full space-y-6 pt-6">
        {topic === "home" &&
          (preview ? (
            <div className="space-y-3 text-sm leading-7">
              <h2>{document.home.name}</h2>
              {document.home.intro && (
                <p className="whitespace-pre-line">{document.home.intro}</p>
              )}
              <p>{document.home.address}</p>
              <p>
                {document.home.host}: {document.home.hostPhone} ·{" "}
                {document.home.hostEmail}
              </p>
              <p>Wi-Fi: {document.home.wifiNetwork}</p>
            </div>
          ) : (
            <div className="space-y-4">
              <TextField
                label="Introduction"
                value={document.home.intro}
                multiline
                onChange={(intro) => {
                  setDocument((current) => ({
                    ...current,
                    home: { ...current.home, intro },
                  }));
                  setMessage("");
                }}
              />
              {(
                [
                  "name",
                  "host",
                  "hostPhone",
                  "hostEmail",
                  "address",
                  "neighbourhood",
                  "wifiNetwork",
                ] satisfies (keyof GuideDocument["home"])[]
              ).map((key) => (
                <TextField
                  key={key}
                  label={
                    {
                      name: "Building name",
                      host: "Host name",
                      hostPhone: "Phone number",
                      hostEmail: "Email",
                      address: "Address",
                      neighbourhood: "Neighbourhood",
                      wifiNetwork: "Wi-Fi network name",
                    }[key]
                  }
                  value={document.home[key]}
                  onChange={(value) => {
                    setDocument((current) => ({
                      ...current,
                      home: { ...current.home, [key]: value },
                    }));
                    setMessage("");
                  }}
                />
              ))}
              <WifiSetup
                network={document.home.wifiNetwork}
                configured={false}
                onSaved={() =>
                  setMessage(
                    "Wi-Fi password saved. Guests can copy it or scan its QR code.",
                  )
                }
              />
            </div>
          ))}
        {article &&
          (preview ? (
            <section
              className="space-y-5 text-sm leading-7"
              aria-label="Topic preview"
            >
              <h2 className="text-lg">{article.title}</h2>
              <ArticleContent article={article} />
            </section>
          ) : (
            <div className="space-y-6">
              <TextField
                label="Title"
                value={article.title}
                onChange={(title) => updateArticle({ title })}
              />
              <TextField
                label="Summary"
                value={article.summary}
                onChange={(summary) => updateArticle({ summary })}
              />
              <RichEditor
                key={article.id}
                value={article.body ?? legacyBody(article)}
                disabled={busy}
                onChange={(body) => updateArticle({ body })}
                onValidityChange={setRichError}
              />
              <section
                className="space-y-4 border-t pt-5"
                aria-label="AI-only notes"
              >
                <h2 className="text-sm font-medium">AI-only notes</h2>
                <p className="text-xs leading-6">
                  Used to answer questions in chat. These notes stay off the
                  visible guide cards.
                </p>
                <AiNotes
                  key={article.id}
                  values={facts}
                  onChange={updateKnowledge}
                />
              </section>
            </div>
          ))}
      </fieldset>
    </main>
  );
}
