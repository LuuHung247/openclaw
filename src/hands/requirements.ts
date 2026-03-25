/**
 * Hand Requirements Checker — Verify system requirements for Hands
 *
 * Checks for:
 * - Binary availability (which/where)
 * - Environment variables
 * - API keys in config
 * - File existence
 */

import { existsSync } from "node:fs";
import type { HandDefinition, HandRequirementCheck } from "./types.js";

/**
 * Check if a binary is available on the system
 */
async function checkBinary(binaryName: string): Promise<boolean> {
  try {
    // Try using Node's child_process for broader compatibility
    const { execSync } = require("node:child_process");
    execSync(`which ${binaryName}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an environment variable is set
 */
function checkEnv(envName: string): boolean {
  return process.env[envName] !== undefined && process.env[envName] !== "";
}

/**
 * Check if an API key is configured (placeholder - depends on config system)
 */
function checkApiKey(keyName: string): boolean {
  // TODO: Integrate with config system to check for API keys
  // For now, check environment variable as fallback
  const envVar = `${keyName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  return checkEnv(envVar);
}

/**
 * Check if a file exists
 */
function checkFile(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Check all requirements for a Hand
 */
export async function checkRequirements(
  definition: HandDefinition,
): Promise<HandRequirementCheck> {
  const met: string[] = [];
  const missing: string[] = [];
  const optional: string[] = [];

  for (const req of definition.requires) {
    let ok = false;

    switch (req.type) {
      case "binary":
        ok = await checkBinary(req.check);
        break;
      case "env":
        ok = checkEnv(req.check);
        break;
      case "api-key":
        ok = checkApiKey(req.check);
        break;
      case "file":
        ok = checkFile(req.check);
        break;
      default:
        ok = false;
    }

    if (ok) {
      met.push(req.label);
    } else {
      missing.push(req.label);
    }
  }

  return {
    ok: missing.length === 0,
    met,
    missing,
    optional,
  };
}
