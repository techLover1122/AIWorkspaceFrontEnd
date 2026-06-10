"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { INSTANCE_IP } from "../constant/api";

// Render the workspace CLIENT-ONLY (no SSR). This app only ever runs inside
// the Electron desktop shell (or a browser pointed at the live workspace), so
// server rendering buys nothing — and the entire tree depends on client-only
// state (localStorage sessions, the Electron preload APIs, window geometry).
// Disabling SSR here eliminates the whole class of hydration mismatches at the
// root instead of guarding every server/client branch individually.
const WorkspaceShell = dynamic(
  () => import("../components/workspace/workspace-shell").then((m) => m.WorkspaceShell),
  {
    ssr: false,
    loading: () => <div className="workspace-loading">Loading workspace...</div>,
  }
);
import { base64UrlDecode, base64UrlEncode } from "../constant/utils";

/**
 * Default workspace folder the VS Code iframe opens when the user hasn't
 * explicitly picked a project via `?project=`. Without this, the iframe
 * URL ships without `?folder=` and code-server falls back to whatever its
 * per-user state restoration decides — usually a "No Folder Opened"
 * screen. We open the user's home directory so the Explorer shows the
 * full filesystem (AI-IDE/, .config/, .claude/, ...) and they can pick
 * a subfolder from there.
 *
 * Configurable via `NEXT_PUBLIC_DEFAULT_WORKSPACE_DIR` (set in the
 * frontend's systemd unit on EC2 by cloud-init / update-ec2.sh). Falls
 * back to the conventional Ubuntu home used by both scripts/cloud-init.sh
 * and the Terraform workspace cloud-init.
 */
const DEFAULT_WORKSPACE_DIR =
  process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_DIR ?? "/home/ubuntu";

export function HomePageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectEncoded = searchParams.get("project");
  const codeServerUrl =
    process.env.NEXT_PUBLIC_CODE_SERVER_URL ?? `http://${INSTANCE_IP}:8080`;

  let workingDirectory: string | undefined = DEFAULT_WORKSPACE_DIR;
  if (projectEncoded) {
    try {
      workingDirectory = base64UrlDecode(projectEncoded);
    } catch {
      // Bad encoding — fall back to the project-root default rather than
      // letting code-server land on its "No Folder Opened" screen.
      workingDirectory = DEFAULT_WORKSPACE_DIR;
    }
  }

  const handleProjectChange = useCallback(
    (path: string) => {
      const encoded = base64UrlEncode(path);
      router.push(`/?project=${encoded}`);
    },
    [router]
  );

  return (
    <WorkspaceShell
      codeServerUrl={codeServerUrl}
      workingDirectory={workingDirectory}
      onChangeProject={handleProjectChange}
    />
  );
}
