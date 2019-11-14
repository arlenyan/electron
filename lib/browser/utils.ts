import { EventEmitter } from 'events'

/**
* Creates a lazy instance of modules that can't be required before the
* app 'ready' event by returning a proxy object to mitigate side effects
* on 'require'
*
* @param {Function} creator - Function that creates a new module instance
* @param {Object} holder - the object holding the module prototype
* @param {Boolean} isEventEmitter - whether or not the module is an EventEmitter
* @returns {Object} - a proxy object for the
*/

export function createLazyInstance (
  creator: Function,
  holder: Object,
  isEventEmitter: Boolean
) {
  let lazyModule: Object
  const module: any = {}
  for (const method in (holder as any).prototype) {
    module[method] = (...args: any) => {
      // create new instance of module at runtime if none exists
      if (!lazyModule) {
        lazyModule = creator()
        if (isEventEmitter) EventEmitter.call(lazyModule as any)
      }

      // check for properties on the prototype chain that aren't functions
      if (typeof (lazyModule as any)[method] !== 'function') {
        return (lazyModule as any)[method]
      }

      return (lazyModule as any)[method](...args)
    }
  }
  return module
}

// Roughly an implementation of `_.merge()`
export function deepMerge (
  target: { [key: string]: any },
  source: { [key: string]: any },
  visited?: Set<any>
) {
  // Check for circular reference.
  if (visited == null) visited = new Set()
  if (visited.has(source)) return

  visited.add(source)
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue

    const value = source[key]
    if (typeof value === 'object' && !Array.isArray(value)) {
      target[key] = deepMerge(target[key] || {}, value, visited)
    } else {
      if (key in target) continue
      target[key] = value
    }
  }
  visited.delete(source)

  return target
}
