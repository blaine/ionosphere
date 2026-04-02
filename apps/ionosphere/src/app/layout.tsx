import type { Metadata } from "next";
import "./globals.css";
import NavHeader from "@/app/components/NavHeader";
import { AuthProvider } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Ionosphere",
  description: "Semantically enriched conference video archive for ATmosphereConf 2026",
  metadataBase: new URL("https://ionosphere.tv"),
  openGraph: {
    title: "Ionosphere",
    description: "Semantically enriched conference video archive for ATmosphereConf 2026",
    url: "https://ionosphere.tv",
    siteName: "Ionosphere",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Ionosphere",
    description: "Semantically enriched conference video archive for ATmosphereConf 2026",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 h-dvh overflow-hidden flex flex-col">
        <AuthProvider>
          <NavHeader />
          <main className="flex-1 min-h-0">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
