import { notFound } from "next/navigation";

// Unknown paths under a valid locale: render [locale]/not-found.tsx inside the locale layout (lang, dir, fonts).
export default function UnknownPath() {
  notFound();
}
