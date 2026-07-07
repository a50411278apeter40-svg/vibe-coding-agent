import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PIXAL2.0',
  description: 'PIXAL2.0 — an AI web-builder agent that builds, previews, and ships sandbox projects for you.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
