"use client";
import { memo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ArrowUp, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Streamdown } from "streamdown";
import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/ui/message-scroller";
import {
  Message,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
const transport = new DefaultChatTransport({ api: "/api/chat" });
const suggestions = [
  "Where does the recycling go?",
  "How do I access the garage?",
  "How do I book the BBQ?",
];
const ChatResponse = memo(function ChatResponse({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  return (
    <Streamdown
      linkSafety={{ enabled: false }}
      isAnimating={streaming}
      className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
    >
      {text}
    </Streamdown>
  );
});
export function GuestChat({
  onArticleOpen,
}: {
  onArticleOpen: (id: string) => boolean;
}) {
  const {
    messages,
    sendMessage,
    status,
    error,
    setMessages,
    clearError,
    stop,
  } = useChat({ transport });
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";
  function send(text: string) {
    if (!text.trim() || busy) return;
    clearError();
    void sendMessage({ text: text.trim() });
    setInput("");
  }
  return (
    <>
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport aria-label="Apartment conversation">
            <MessageScrollerContent
              className="gap-6 px-5 py-6"
              role="log"
              aria-live="polite"
              aria-label="Chat messages"
            >
              {messages.length === 0 && (
                <MessageScrollerItem messageId="suggestions">
                  <div className="py-2">
                    <div className="flex flex-col gap-3">
                      {suggestions.map((text) => (
                        <Button
                          variant="outline"
                          className="h-auto min-h-12 justify-start whitespace-normal px-4 py-3 text-left normal-case"
                          onClick={() => send(text)}
                          key={text}
                        >
                          {text}
                        </Button>
                      ))}
                    </div>
                  </div>
                </MessageScrollerItem>
              )}
              {messages.map((message) => (
                <MessageScrollerItem
                  messageId={message.id}
                  scrollAnchor={message.role === "user"}
                  key={message.id}
                >
                  <Message align={message.role === "user" ? "end" : "start"}>
                    <MessageContent>
                      <MessageHeader>
                        {message.role === "user" ? "You" : "bent.stay"}
                      </MessageHeader>
                      <Bubble
                        variant={message.role === "user" ? "outline" : "ghost"}
                        align={message.role === "user" ? "end" : "start"}
                        className="max-w-full"
                      >
                        <BubbleContent
                          className="text-base leading-7 rounded-none"
                          onClick={(event) => {
                            if (
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey
                            )
                              return;
                            if (!(event.target instanceof Element)) return;
                            const href = event.target
                              .closest("a")
                              ?.getAttribute("href");
                            const id = href?.match(/^\/#([a-z0-9-]+)$/)?.[1];
                            if (id && onArticleOpen(id)) event.preventDefault();
                          }}
                        >
                          {message.parts.map((part, index) =>
                            part.type === "text" ? (
                              <ChatResponse
                                key={`${message.id}-${index}`}
                                text={part.text}
                                streaming={
                                  status === "streaming" &&
                                  message.id === messages.at(-1)?.id
                                }
                              />
                            ) : null,
                          )}
                        </BubbleContent>
                      </Bubble>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              ))}
              {status === "submitted" && (
                <MessageScrollerItem messageId="checking">
                  <Marker role="status">
                    <MarkerContent className="shimmer">checking…</MarkerContent>
                  </Marker>
                </MessageScrollerItem>
              )}
              {error && (
                <MessageScrollerItem messageId="error">
                  <Marker role="alert" className="border p-4 text-sm leading-6">
                    <MarkerContent>
                      {error.message ||
                        "Chat is unavailable right now. Try the guide search."}
                      <Button
                        variant="outline"
                        className="mt-3"
                        onClick={() => {
                          setMessages([]);
                          clearError();
                        }}
                      >
                        new chat
                      </Button>
                    </MarkerContent>
                  </Marker>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton
            aria-label="Scroll to latest message"
            className="min-h-11 min-w-11"
          />
        </MessageScroller>
      </MessageScrollerProvider>
      <div className="border-t px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="mb-3"
            disabled={busy}
            onClick={() => {
              setMessages([]);
              clearError();
            }}
          >
            <RotateCcw size={14} /> new chat
          </Button>
        )}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            send(input);
          }}
        >
          <Input
            aria-label="Your question"
            placeholder="ask a question"
            maxLength={2000}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className="h-12 text-base"
          />
          {busy ? (
            <Button
              type="button"
              size="icon"
              className="size-12 shrink-0"
              aria-label="Stop response"
              onClick={() => void stop()}
            >
              <Square size={16} />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              className="size-12 shrink-0"
              disabled={!input.trim()}
              aria-label="Send question"
            >
              <ArrowUp size={20} />
            </Button>
          )}
        </form>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          AI answers can be wrong.
        </p>
        <details className="mt-2 text-xs leading-5">
          <summary className="cursor-pointer">privacy</summary>
          <p className="pt-2">
            Your questions, guide information and relevant manual passages are
            sent to the AI provider. Chats are not saved here.
          </p>
        </details>
      </div>
    </>
  );
}
