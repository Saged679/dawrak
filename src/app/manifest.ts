import type { MetadataRoute } from "next";
import { LOGO_COLORS } from "@/lib/brand/logo-geometry";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dawrak | دورك",
    short_name: "دورك",
    description: "مساعد يحجز مواعيد العيادات والصالونات | An assistant that books clinic and salon appointments",
    start_url: "/ar",
    scope: "/",
    display: "standalone",
    background_color: LOGO_COLORS.mist,
    theme_color: LOGO_COLORS.cobalt,
    lang: "ar",
    dir: "rtl",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
