// Compiles `components/schemas/*` from openapi.yaml with Ajv (2020-12) so contract tests validate real HTTP bodies.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { parse } from 'yaml'

const OPENAPI_PATH = fileURLToPath(new URL('../../openapi.yaml', import.meta.url))
const DOC_ID = 'amazing-cli-openapi'

export interface OpenApiDocument {
  openapi: string
  paths: Record<string, Record<string, unknown>>
  components: { schemas: Record<string, unknown> }
}

export function loadOpenApi(): OpenApiDocument {
  return parse(readFileSync(OPENAPI_PATH, 'utf8')) as OpenApiDocument
}

export interface OpenApiValidator {
  doc: OpenApiDocument
  /** Throws an AssertionError-like Error listing Ajv errors when `value` does not match `components/schemas/<name>`. */
  assertValid(schemaName: string, value: unknown, label?: string): void
}

export function createOpenApiValidator(doc: OpenApiDocument = loadOpenApi()): OpenApiValidator {
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  addFormats.default(ajv) // CJS package: under NodeNext the default import is `module.exports`, whose `.default` is the plugin
  // Only `components` is registered; `$ref: '#/components/schemas/X'` resolves against this id.
  ajv.addSchema({ $id: DOC_ID, components: doc.components })
  const cache = new Map<string, ValidateFunction>()

  return {
    doc,
    assertValid(schemaName, value, label = schemaName) {
      let validate = cache.get(schemaName)
      if (!validate) {
        validate = ajv.getSchema(`${DOC_ID}#/components/schemas/${schemaName}`)
        if (!validate) throw new Error(`openapi.yaml has no components/schemas/${schemaName}`)
        cache.set(schemaName, validate)
      }
      if (!validate(value)) {
        throw new Error(`${label} does not match schema ${schemaName}: ${ajv.errorsText(validate.errors, { separator: '; ' })}\n${JSON.stringify(value, null, 2)}`)
      }
    },
  }
}
