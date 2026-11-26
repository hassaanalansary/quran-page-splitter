import { createFileRoute, Outlet } from "@tanstack/react-router";

import { TopBar } from "@/components/app/TopBar";

/** Layout for the public gallery: the listing and the read-only detail page.
 *
 * This file is not optional. With `gallery.index.tsx` present the route
 * generator emits a parent reference for it, and having no `gallery.tsx` leaves
 * that parent undefined — the tree then fails to build and every `/gallery`
 * URL falls through to Not Found. `routeTree.gen.ts` carries `@ts-nocheck`, so
 * `tsc` will not warn you about it either.
 *
 * Public — deliberately no `beforeLoad` guard. Anyone may browse and download;
 * only copying needs an account. This is also where anonymous visitors to `/`
 * are sent, so it doubles as the app's landing page.
 */
export const Route = createFileRoute("/gallery")({ component: GalleryLayout });

function GalleryLayout() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper">
      <TopBar current="gallery" />
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
