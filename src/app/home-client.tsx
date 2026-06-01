"use client";

import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { WorkspaceShell } from "../components/workspace/workspace-shell";
import { INSTANCE_IP } from "../constant/api";
import { base64UrlDecode, base64UrlEncode } from "../constant/utils";

/**
 * Default workspace folder the VS Code iframe opens when the user hasn't
 * explicitly picked a project via `?project=`. Without this, the iframe
 * URL ships without `?folder=` and code-server falls back to whatever its
 * per-user state restoration decides — usually the home directory or a
 * "No Folder Opened" screen. That's confusing on a fresh workspace; we
 * want it to land in the AI-IDE project root by default.
 *
 * Configurable via `NEXT_PUBLIC_DEFAULT_WORKSPACE_DIR` (set in the
 * frontend's systemd unit on EC2 by cloud-init / update-ec2.sh). Falls
 * back to the conventional Ubuntu path used by both scripts/cloud-init.sh
 * and the Terraform workspace cloud-init.
 */
const DEFAULT_WORKSPACE_DIR =
  process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE_DIR ?? "/home/ubuntu/AI-IDE";

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
