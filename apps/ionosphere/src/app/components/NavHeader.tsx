"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import AuthButton from "./AuthButton";

const NAV_ITEMS = [
  { href: "/talks", label: "Talks" },
  { href: "/tracks", label: "Tracks" },
  { href: "/speakers", label: "Speakers" },
  { href: "/concepts", label: "Concepts" },
  { href: "/concordance", label: "Index" },
  { href: "/highlights", label: "Highlights" },
  { href: "/discussion", label: "Community" },
];

export default function NavHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  const currentLabel = NAV_ITEMS.find((item) => pathname.startsWith(item.href))?.label || "Talks";

  return (
    <header className="shrink-0 border-b border-neutral-800 px-4 py-2">
      <nav className="flex items-center gap-5">
        <a href="/talks" className="shrink-0 whitespace-nowrap">
          <span className="text-lg font-bold tracking-tight">Ionosphere</span>
          <span className="text-xs text-neutral-500 ml-1.5 hidden sm:inline">ATmosphereConf 2026</span>
        </a>

        {/* Desktop nav */}
        {NAV_ITEMS.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className={`text-sm hidden md:block ${
              pathname.startsWith(item.href)
                ? "text-neutral-100"
                : "text-neutral-400 hover:text-neutral-100"
            }`}
          >
            {item.label}
          </a>
        ))}

        <div className="ml-auto hidden md:block"><AuthButton /></div>

        {/* Mobile: current section + hamburger */}
        <div className="md:hidden flex items-center gap-2 ml-auto relative">
          <span className="text-sm text-neutral-300">{currentLabel}</span>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="w-8 h-8 flex items-center justify-center text-neutral-400 hover:text-neutral-100"
            aria-label="Navigation menu"
          >
            {menuOpen ? (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4L14 14M14 4L4 14" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 4H16M2 9H16M2 14H16" />
              </svg>
            )}
          </button>

          {/* Dropdown */}
          {menuOpen && (
            <div className="absolute top-full right-0 mt-1 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl py-1 z-50 min-w-[160px]">
              {NAV_ITEMS.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  className={`block px-4 py-2.5 text-sm ${
                    pathname.startsWith(item.href)
                      ? "text-neutral-100 bg-neutral-800"
                      : "text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800"
                  }`}
                >
                  {item.label}
                </a>
              ))}
              <div className="border-t border-neutral-700 px-4 py-2.5">
                <AuthButton />
              </div>
            </div>
          )}
        </div>
      </nav>
    </header>
  );
}
