import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ionosphere",
  description: "Semantically enriched conference video archive for ATmosphereConf 2026",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 min-h-screen">
        <header className="border-b border-neutral-800 px-6 py-4">
          <nav className="max-w-6xl mx-auto flex items-center gap-6">
            <a href="/" className="text-xl font-bold tracking-tight">Ionosphere</a>
            <a href="/talks" className="text-neutral-400 hover:text-neutral-100">Talks</a>
            <a href="/speakers" className="text-neutral-400 hover:text-neutral-100">Speakers</a>
            <a href="/concepts" className="text-neutral-400 hover:text-neutral-100">Concepts</a>
          </nav>
        </header>
        <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
