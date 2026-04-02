"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AuthCallback() {
  const router = useRouter();

  useEffect(() => {
    const returnTo = sessionStorage.getItem("auth_return_to") || "/talks";
    router.replace(returnTo);
  }, [router]);

  return (
    <div className="h-full flex items-center justify-center text-neutral-400">
      Signing in...
    </div>
  );
}
