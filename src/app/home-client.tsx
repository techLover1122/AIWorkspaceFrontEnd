"use client";

import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { WorkspaceShell } from "../components/workspace/workspace-shell";
import { base64UrlDecode, base64UrlEncode } from "../constant/utils";

export function HomePageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectEncoded = searchParams.get("project");
  const codeServerUrl =
    process.env.NEXT_PUBLIC_CODE_SERVER_URL ?? "http://localhost:8080";

  let workingDirectory: string | undefined;
  if (projectEncoded) {
    try {
      workingDirectory = base64UrlDecode(projectEncoded);
    } catch {
      workingDirectory = undefined;
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
