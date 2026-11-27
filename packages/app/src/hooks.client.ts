import type { HandleClientError } from "@sveltejs/kit/hooks";
import { describeError } from "#lib/utils/page-error.ts";

export const handleError: HandleClientError = ({ kind, error }) => describeError(kind, error);
