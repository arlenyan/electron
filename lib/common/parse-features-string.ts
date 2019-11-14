import { BrowserWindowConstructorOptions } from 'electron'

type A = Required<BrowserWindowConstructorOptions>
type KeysOfTypeInteger = {
  [K in keyof A]:
    A[K] extends number ? K : never
}[keyof A]

// This could be an array of keys, but an object allows us to add a compile-time
// check validating that we haven't added an integer property to
// BrowserWindowConstructorOptions that this module doesn't know about.
const objectForCompileTimeCheck: { [K in KeysOfTypeInteger] : true } = {
  x: true,
  y: true,
  width: true,
  height: true,
  minWidth: true,
  maxWidth: true,
  minHeight: true,
  maxHeight: true,
  opacity: true
}
const keysOfTypeNumber = Object.keys(objectForCompileTimeCheck)

/**
 * Note that we only allow "0" and "1" boolean conversion when the type is known
 * not to be an integer.
 *
 * The coercion of yes/no/1/0 represents best effort accordance with the spec:
 * https://html.spec.whatwg.org/multipage/window-object.html#concept-window-open-features-parse-boolean
 */
type CoercedValue = string | number | boolean
function coerce (key: string, value: string): CoercedValue {
  if (keysOfTypeNumber.includes(key)) {
    return Number(value)
  }

  // TODO: deprecation notice for undefined behavior
  switch (value) {
    case 'true':
    case '1':
    case 'yes':
    case undefined:
      return true
    case 'false':
    case '0':
    case 'no':
      return false
    default:
      return value
  }
}

// parses a feature string that has the format used in window.open()
// - `features` input string
// - `emit` function(key, value) - called for each parsed KV
function parseFeaturesWithValueCoercion (
  features: string,
  useDeprecatedBehaviorForBareKeys
): {
  options: Omit<BrowserWindowConstructorOptions, 'webPreferences'> & { [key: string]: CoercedValue };
  webPreferences: BrowserWindowConstructorOptions['webPreferences'];
  additionalFeatures: string[];
} {
  const bareKeys = [] as string[]
  const parsed = features.split(',').reduce((map, keyValuePair) => {
    const [key, value] = keyValuePair.split('=').map(str => str.trim())

    if (useDeprecatedBehaviorForBareKeys && value === undefined) {
      bareKeys.push(key)
      return map
    }

    map[key] = coerce(key, value)
    return map
  }, {} as { [key: string]: any })

  return {
    bareKeys,
    parsed
  }
}

export default parseFeaturesWithValueCoercion
