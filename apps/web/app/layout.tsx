import type { Metadata } from "next";
import { AuthProvider } from "./lib/auth-client";
import { GameClientProvider } from "./lib/game-client";
import "./globals.css";

export const metadata: Metadata = {
  title: "谁是AI",
  description: "真人玩家与 AI 玩家同场推理的最小可运行版本",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <AuthProvider>
          <GameClientProvider>{children}</GameClientProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
