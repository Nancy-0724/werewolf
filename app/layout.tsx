import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "狼人殺 AI · Web Alpha",
  description: "12 人狼美人板：1 位真人 + 11 位 NPC 的狼人殺 Web Alpha",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
