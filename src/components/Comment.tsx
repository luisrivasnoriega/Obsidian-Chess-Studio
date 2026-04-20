import { TypographyStylesProvider } from "@mantine/core";

import Markdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";

const MOJIBAKE_HINT = /[ÃÂâ]/;

function repairMojibake(text: string): string {
  if (!text || !MOJIBAKE_HINT.test(text)) return text;
  try {
    const bytes = Uint8Array.from(Array.from(text, (ch) => ch.charCodeAt(0) & 0xff));
    const decoded = new TextDecoder("utf-8").decode(bytes);
    if (!decoded || decoded.includes("�")) return text;
    return decoded;
  } catch {
    return text;
  }
}

export function Comment({ comment }: { comment: string }) {
  const safeComment = repairMojibake(comment);
  const multipleLine = safeComment.split("\n").filter((v) => v.trim() !== "").length > 1;

  return (
    <TypographyStylesProvider
      style={{
        display: multipleLine ? "block" : "inline",
        lineHeight: multipleLine ? undefined : "inherit",
      }}
    >
      <Markdown
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          p: ({ children }) => (
            <span
              style={{
                display: multipleLine ? "block" : "inline",
                marginBottom: multipleLine ? undefined : 0,
              }}
            >
              {children}
            </span>
          ),
        }}
        rehypePlugins={[rehypeRaw, remarkGfm]}
      >
        {safeComment}
      </Markdown>
    </TypographyStylesProvider>
  );
}
