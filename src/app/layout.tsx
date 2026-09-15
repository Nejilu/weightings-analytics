import type { Metadata } from "next";
import { headers } from "next/headers";
import Script from "next/script";
import type { ReactNode } from "react";

import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  const configuredOrigin = [
    process.env.SITE_PUBLIC_ORIGIN,
    process.env.SITE_OWNER_ORIGIN,
  ].find((value) => {
    try {
      return value && new URL(value).host === host;
    } catch {
      return false;
    }
  });
  const metadataBase = new URL(configuredOrigin ?? "http://localhost:3000");
  const title = "Weightings Analytics — Holdings & Portfolio Look-Through";
  const description =
    "Explore ETF holdings, free-float weight distortion, optional peer comparisons, and security-level portfolios.";

  return {
    metadataBase,
    robots: {
      index: configuredOrigin === process.env.SITE_PUBLIC_ORIGIN && Boolean(configuredOrigin),
      follow: true,
    },
    title,
    description,
    openGraph: {
      title,
      description,
      type: "website",
      url: "/",
      images: [
        {
          url: "/og.png",
          width: 1732,
          height: 908,
          alt: "Weightings Analytics holdings and portfolio analytics",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var saved=localStorage.getItem("weightings-analytics-theme");var theme=saved==="light"||saved==="dark"?saved:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme}catch(e){}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
