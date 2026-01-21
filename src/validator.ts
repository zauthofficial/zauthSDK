/**
 * Response validator for determining if responses are "meaningful"
 */

import type { ValidationConfig } from './types/config.js';
import type { ValidationResult, ValidationCheck } from './types/events.js';
import { isEmptyResponse, hasErrorIndicators } from './utils.js';

/**
 * Validate a response against configured rules
 */
export function validateResponse(
  body: unknown,
  statusCode: number,
  config: ValidationConfig
): ValidationResult {
  const checks: ValidationCheck[] = [];
  let meaningfulnessScore = 1.0;

  // Check 1: Status code
  const isSuccessStatus = statusCode >= 200 && statusCode < 300;
  checks.push({
    name: 'status_code',
    passed: isSuccessStatus,
    message: isSuccessStatus ? 'Success status code' : `Non-success status: ${statusCode}`,
  });
  if (!isSuccessStatus) {
    meaningfulnessScore -= 0.3;
  }

  // Check 2: Not empty
  const isEmpty = isEmptyResponse(body, config.minResponseSize ?? 2);
  checks.push({
    name: 'not_empty',
    passed: !isEmpty,
    message: isEmpty ? 'Response is empty or too small' : 'Response has content',
  });
  if (isEmpty) {
    meaningfulnessScore -= 0.4;
  }

  // Check 3: No error indicators
  const hasErrors = hasErrorIndicators(body, config.errorFields);
  checks.push({
    name: 'no_error_fields',
    passed: !hasErrors,
    message: hasErrors ? 'Response contains error indicators' : 'No error indicators found',
  });
  if (hasErrors) {
    meaningfulnessScore -= 0.3;
  }

  // Check 4: Required fields present
  if (config.requiredFields && config.requiredFields.length > 0) {
    const missingFields: string[] = [];

    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const obj = body as Record<string, unknown>;
      for (const field of config.requiredFields) {
        if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
          missingFields.push(field);
        }
      }
    } else {
      missingFields.push(...config.requiredFields);
    }

    const hasRequired = missingFields.length === 0;
    checks.push({
      name: 'required_fields',
      passed: hasRequired,
      message: hasRequired
        ? 'All required fields present'
        : `Missing fields: ${missingFields.join(', ')}`,
    });
    if (!hasRequired) {
      meaningfulnessScore -= 0.2;
    }
  }

  // Check 5: Empty collections
  if (config.rejectEmptyCollections && body && typeof body === 'object') {
    const hasEmptyCollection = checkEmptyCollections(body);
    checks.push({
      name: 'non_empty_collections',
      passed: !hasEmptyCollection,
      message: hasEmptyCollection
        ? 'Response contains empty arrays or objects'
        : 'Collections have content',
    });
    if (hasEmptyCollection) {
      meaningfulnessScore -= 0.1;
    }
  }

  // Check 6: Custom validator
  if (config.customValidator) {
    try {
      const customResult = config.customValidator(body, statusCode);
      checks.push(...customResult.checks);
      if (!customResult.valid) {
        meaningfulnessScore -= 0.3;
      }
    } catch (error) {
      checks.push({
        name: 'custom_validator',
        passed: false,
        message: `Custom validator error: ${(error as Error).message}`,
      });
    }
  }

  // Normalize score
  meaningfulnessScore = Math.max(0, Math.min(1, meaningfulnessScore));

  // Determine overall validity
  const valid = meaningfulnessScore >= 0.5 && isSuccessStatus && !isEmpty;

  // Build reason if not valid
  let reason: string | undefined;
  if (!valid) {
    const failedChecks = checks.filter(c => !c.passed);
    reason = failedChecks.map(c => c.message).join('; ');
  }

  return {
    valid,
    checks,
    meaningfulnessScore,
    reason,
  };
}

/**
 * Check if object has empty collections at top level
 */
function checkEmptyCollections(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') {
    return false;
  }

  // Check if the object itself is empty
  if (Array.isArray(obj)) {
    return obj.length === 0;
  }

  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0) {
    return true;
  }

  // Check top-level values for empty arrays/objects (common pattern)
  for (const [, value] of entries) {
    if (Array.isArray(value) && value.length === 0) {
      return true;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
      return true;
    }
  }

  return false;
}

/**
 * Simple schema validator (basic implementation)
 * For production, consider using ajv or zod
 */
export function validateSchema(
  body: unknown,
  schema: Record<string, unknown>
): ValidationResult {
  const checks: ValidationCheck[] = [];

  // Basic type check
  const expectedType = schema.type as string;
  const actualType = Array.isArray(body) ? 'array' : typeof body;

  if (expectedType && expectedType !== actualType) {
    checks.push({
      name: 'type',
      passed: false,
      message: `Expected ${expectedType}, got ${actualType}`,
    });
    return {
      valid: false,
      checks,
      meaningfulnessScore: 0,
      reason: `Type mismatch: expected ${expectedType}`,
    };
  }

  checks.push({
    name: 'type',
    passed: true,
    message: `Type is ${actualType}`,
  });

  // Check required properties for objects
  if (schema.required && Array.isArray(schema.required) && typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>;
    const missing = (schema.required as string[]).filter(prop => !(prop in obj));

    if (missing.length > 0) {
      checks.push({
        name: 'required_properties',
        passed: false,
        message: `Missing required: ${missing.join(', ')}`,
      });
      return {
        valid: false,
        checks,
        meaningfulnessScore: 0.3,
        reason: `Missing required properties: ${missing.join(', ')}`,
      };
    }

    checks.push({
      name: 'required_properties',
      passed: true,
      message: 'All required properties present',
    });
  }

  return {
    valid: true,
    checks,
    meaningfulnessScore: 1.0,
  };
}

/**
 * Create a validator from a JSON schema
 */
export function createSchemaValidator(
  schema: Record<string, unknown>
): (body: unknown, statusCode: number) => ValidationResult {
  return (body: unknown, _statusCode: number) => validateSchema(body, schema);
}
