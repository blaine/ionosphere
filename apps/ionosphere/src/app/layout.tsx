import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ionosphere",
  description: "Semantically enriched conference video archive for ATmosphereConf 2026",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 h-dvh overflow-hidden flex flex-col">
        <header className="shrink-0 border-b border-neutral-800 px-4 py-3">
          <nav className="flex items-center gap-5">
            <a href="/" className="text-lg font-bold tracking-tight">Ionosphere</a>
            <a href="/talks" className="text-sm text-neutral-400 hover:text-neutral-100">Talks</a>
            <a href="/speakers" className="text-sm text-neutral-400 hover:text-neutral-100">Speakers</a>
            <a href="/concepts" className="text-sm text-neutral-400 hover:text-neutral-100">Concepts</a>
          </nav>
        </header>
        <main className="flex-1 min-h-0">{children}</main>
      </body>
    </html>
  );
}
