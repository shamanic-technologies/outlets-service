import { ZodSchema, ZodObject, ZodString, ZodNumber, ZodBoolean, ZodArray, ZodEnum, ZodOptional, ZodDefault, ZodNullable, ZodRecord, ZodUnknown, ZodEffects, type ZodTypeAny } from "zod";

export function zodToJsonSchema(schema: ZodSchema): Record<string, unknown> {
  return convertZodType(schema as ZodTypeAny);
}

function convertZodType(schema: ZodTypeAny): Record<string, unknown> {
  if (schema instanceof ZodEffects) {
    return convertZodType(schema._def.schema);
  }

  if (schema instanceof ZodDefault) {
    const inner = convertZodType(schema._def.innerType);
    return { ...inner, default: schema._def.defaultValue() };
  }

  if (schema instanceof ZodOptional) {
    return convertZodType(schema._def.innerType);
  }

  if (schema instanceof ZodNullable) {
    const inner = convertZodType(schema._def.innerType);
    return { ...inner, nullable: true };
  }

  if (schema instanceof ZodString) {
    const result: Record<string, unknown> = { type: "string" };
    for (const check of schema._def.checks) {
      if (check.kind === "uuid") result.format = "uuid";
      if (check.kind === "url") result.format = "uri";
      if (check.kind === "datetime") result.format = "date-time";
      if (check.kind === "min") result.minLength = check.value;
    }
    return result;
  }

  if (schema instanceof ZodNumber) {
    const result: Record<string, unknown> = { type: "number" };
    for (const check of schema._def.checks) {
      if (check.kind === "int") result.type = "integer";
      if (check.kind === "min") result.minimum = check.value;
      if (check.kind === "max") result.maximum = check.value;
    }
    return result;
  }

  if (schema instanceof ZodBoolean) {
    return { type: "boolean" };
  }

  if (schema instanceof ZodEnum) {
    return { type: "string", enum: schema._def.values };
  }

  if (schema instanceof ZodArray) {
    return {
      type: "array",
      items: convertZodType(schema._def.type),
    };
  }

  if (schema instanceof ZodRecord) {
    return { type: "object", additionalProperties: true };
  }

  if (schema instanceof ZodUnknown) {
    return {};
  }

  if (schema instanceof ZodObject) {
    const shape = schema._def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convertZodType(value as ZodTypeAny);
      if (!(value instanceof ZodOptional) && !(value instanceof ZodDefault)) {
        required.push(key);
      }
    }

    const result: Record<string, unknown> = { type: "object", properties };
    if (required.length > 0) result.required = required;
    return result;
  }

  return { type: "string" };
}
