import { Suspense } from "react";
import { HomePageClient } from "./home-client";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <Suspense fallback={<div className="workspace-loading">Loading workspace...</div>}>
      <HomePageClient />
    </Suspense>
  );
}
