import { z } from "zod";

export const chatRequestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            id: z.string().max(100),
            role: z.enum(["user", "assistant"]),
            parts: z
              .array(
                z.discriminatedUnion("type", [
                  z.object({
                    type: z.literal("text"),
                    text: z.string().max(4000),
                  }),
                  z.object({ type: z.literal("step-start") }),
                ]),
              )
              .min(1)
              .max(8),
          })
          .superRefine((message, context) => {
            if (
              message.role === "user" &&
              message.parts.some((part) => part.type !== "text")
            )
              context.addIssue({
                code: "custom",
                message: "Questions must contain text only.",
                path: ["parts"],
              });
            if (
              message.role === "user" &&
              !message.parts.some(
                (part) => part.type === "text" && part.text.trim(),
              )
            )
              context.addIssue({
                code: "custom",
                message: "Enter a question.",
                path: ["parts"],
              });
          }),
      )
      .min(1)
      .max(20),
  })
  .transform((request) => ({
    // Stream boundaries belong to the SDK UI, not the text conversation sent to the model.
    // An answer stopped before its first token may contain only a boundary marker.
    messages: request.messages
      .map((message) => ({
        ...message,
        parts: message.parts.filter(
          (part) => part.type === "text" && part.text.trim(),
        ),
      }))
      .filter((message) => message.role === "user" || message.parts.length > 0),
  }));
