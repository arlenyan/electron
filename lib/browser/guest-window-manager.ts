/**
 * Create and minimally track guest windows at the direction of the renderer (via
 * window.open). Here, "guest" roughly means "child" — it's not necessarily
 * emblematic of its process status; both in-process (same-origin
 * nativeWindowOpen) and out-of-process (cross-origin nativeWindowOpen and
 * BrowserWindowProxy) are created here.
 */
import { BrowserWindow, BrowserWindowConstructorOptions, WebPreferences, Referrer, WebContents, IpcMainEvent, LoadURLOptions } from 'electron'
import parseFeaturesWithValueCoercion from '../common/parse-features-string'
import { deepMerge } from './utils'

type PostData = LoadURLOptions['postData']
export type WindowOpenArgs = {
  url: string,
  referrer: Referrer,
  frameName: string,
  disposition: string,
  options: BrowserWindowConstructorOptions,
  additionalFeatures: string[],
  postData?: PostData,
}

const frameNamesToWindow = new Map()
export const registerFrameNameToGuestWindow = (name: String, win: BrowserWindow) => frameNamesToWindow.set(name, win)
export const unregisterFrameName = (name: string) => frameNamesToWindow.delete(name)
export const getGuestWindowByFrameName = (name: string) => frameNamesToWindow.get(name)

// Security options that child windows will always inherit from parent windows
const inheritedWebPreferences: Map<keyof WebPreferences, any> = new Map([
  ['contextIsolation', true],
  ['javascript', false],
  ['nativeWindowOpen', true],
  ['nodeIntegration', false],
  ['enableRemoteModule', false],
  ['sandbox', true],
  ['webviewTag', false],
  ['nodeIntegrationInSubFrames', false]
])

/**
 * `openGuestWindow` is called for both implementations of window.open
 * (BrowserWindowProxy and nativeWindowOpen) to create and setup event handling
 * for the new window.
 *
 * Until 9.0.0, when it is deprecated, the `new-window` event is fired, allowing
 * the user to preventDefault() on the passed event (which ends up calling
 * DestroyWebContents in the nativeWindowOpen code path).
 */
export function openGuestWindow (args: {
  event: IpcMainEvent,
  host: WebContents,
  guest?: WebContents,
  browserWindowOptions: BrowserWindowConstructorOptions,
  windowOpenArgs: WindowOpenArgs,
}): BrowserWindow | undefined {
  const { host, guest, browserWindowOptions, windowOpenArgs } = args
  const { url, referrer, frameName, postData } = windowOpenArgs
  const isNativeWindowOpen = !!guest
  const optionsWithDefaults = mergeBrowserWindowOptions(host, browserWindowOptions)

  {
    // DEPRECATED
    // Removing in 9.0.0
    // TODO: Remove the `event` parameter when the `new-window` event is removed.
    const didCancelEvent = emitDeprecatedNewWindowEvent({
      ...args,
      browserWindowOptions: optionsWithDefaults
    })
    if (didCancelEvent) return
  }

  // To spec, subsequent window.open calls with the same frame name (`target` in
  // spec parlance) will reuse the previous window.
  // https://html.spec.whatwg.org/multipage/window-object.html#apis-for-creating-and-navigating-browsing-contexts-by-name
  const existingWindow = getGuestWindowByFrameName(frameName)
  if (existingWindow) {
    existingWindow.loadURL(url)
    return existingWindow.webContents.id
  }

  const window = new BrowserWindow(optionsWithDefaults)
  if (!isNativeWindowOpen) {
    // We should only call `loadURL` if the webContents was constructed by us in
    // the case of BrowserWindowProxy (non-sandboxed, nativeWindowOpen: false),
    // as navigating to the url when creating the window from an existing
    // webContents is not necessary (it will navigate there anyway).
    window.loadURL(url, {
      httpReferrer: referrer,
      ...formatPostDataWithHeaders(postData)
    })
  }

  handleWindowLifecycleEvents({ host, frameName, guest: window })
  return window
}

/**
 * Manage the relationship between host window and guest window. When the guest
 * is destroyed, notify the host. When the host is destroyed, so too is the
 * guest destroyed; this is Electron convention and isn't based in browser
 * behavior.
 */
const handleWindowLifecycleEvents = function ({ host, guest, frameName }: {
  host: WebContents,
  guest: BrowserWindow,
  frameName: string
}) {
  const closedByHost = function () {
    guest.removeListener('closed', closedByUser)
    guest.destroy()
  }
  const closedByUser = function () {
    (host as any)._sendInternal(
      'ELECTRON_GUEST_WINDOW_MANAGER_WINDOW_CLOSED_' + guest.webContents.id
    )
    host.removeListener('current-render-view-deleted' as any, closedByHost)
  }
  host.once('current-render-view-deleted' as any, closedByHost)
  guest.once('closed', closedByUser)

  if (frameName) {
    registerFrameNameToGuestWindow(frameName, guest)
    guest.once('closed', function () {
      unregisterFrameName(frameName)
    })
  }
}

/**
 * Deprecated in favor of `webContents.setWindowOpenOverride` and
 * `did-create-window` in 7.2.0. Will be removed in 9.0.0.
 */
function emitDeprecatedNewWindowEvent ({ event, host, guest, browserWindowOptions, windowOpenArgs }: {
  event: IpcMainEvent,
  host: WebContents,
  guest?: WebContents,
  browserWindowOptions: BrowserWindowConstructorOptions,
  windowOpenArgs: WindowOpenArgs,
}): boolean {
  const { url, frameName, disposition, additionalFeatures, referrer } = windowOpenArgs
  const isWebViewWithPopupsDisabled = host.getType() === 'webview' && (host as any).getLastWebPreferences().disablePopups

  host.emit(
    'new-window',
    event,
    url,
    frameName,
    disposition,
    {
      ...browserWindowOptions,
      webContents: guest
    },
    additionalFeatures,
    referrer
  )

  const { newGuest } = event as any
  if (isWebViewWithPopupsDisabled) {
    return true
  } else if (event.defaultPrevented) {
    if (newGuest) {
      if (guest === newGuest.webContents) {
        // The webContents is not changed, so set defaultPrevented to false to
        // stop the callers of this event from destroying the webContents.
        (event as any).defaultPrevented = false
      }

      handleWindowLifecycleEvents({
        host: event.sender,
        guest: newGuest,
        frameName
      })
    }
    return true
  }
  return false
}

const securityWebPreferenceKeys = ['contextIsolation', 'javascript', 'nativeWindowOpen', 'nodeIntegration', 'enableRemoteModule', 'sandbox', 'webviewTag', 'nodeIntegrationInSubFrames']

function makeBrowserWindowOptions ({ host, features, frameName, overrideOptions, useDeprecatedBehaviorForBareValues = false, useDeprecatedBehaviorForOptionInheritance = false }: {
  host: WebContents,
  features: string,
  frameName: string,
  overrideOptions?: BrowserWindowConstructorOptions,
  useDeprecatedBehaviorForBareValues?: boolean
  useDeprecatedBehaviorForOptionInheritance?: boolean
}) {
  const { options: parsedOptions, webPreferences: parsedWebPreferences, additionalFeatures } = parseFeaturesWithValueCoercion(features, useDeprecatedBehaviorForBareValues)

  const parentWebPreferences = (host as any).getLastWebPreferences()
  const securityWebPreferences = securityWebPreferenceKeys.reduce((map, key) => {
    map[key] = parentWebPreferences[key]
    return map
  }, {} as any)
  const deprecatedInheritedOptions = getDeprecatedInheritedOptions(host)

  return {
    additionalFeatures,
    options: {
      show: true,
      x: parsedOptions.left,
      y: parsedOptions.top,
      title: frameName,
      width: 800,
      height: 600,
      ...(useDeprecatedBehaviorForOptionInheritance && deprecatedInheritedOptions),
      ...parsedOptions,
      ...overrideOptions,
      webPreferences: {
        ...(useDeprecatedBehaviorForOptionInheritance && deprecatedInheritedOptions),
        ...securityWebPreferences,
        ...parsedWebPreferences,
        ...(overrideOptions && overrideOptions.webPreferences),
        // Sets correct openerId here to give correct options to 'new-window' event handler
        // TODO (@loc): Figure out another way to pass this?
        openerId: host.id
      }
    }
  }
}

function getDeprecatedInheritedOptions (host: WebContents) {
  const { type, ...inheritableOptions } = (host as any).browserWindowOptions
  const win = BrowserWindow.fromWebContents(host)
  if (!win) return inheritableOptions
  return {
    ...inheritableOptions,
    show: win.isVisible()
  }
}

// Merge |options| with the |embedder|'s window's options.
const mergeBrowserWindowOptions = function (embedder: any, options: BrowserWindowConstructorOptions) {
  if (options.webPreferences == null) {
    options.webPreferences = {}
  }
  if (embedder.browserWindowOptions != null) {
    let parentOptions = embedder.browserWindowOptions

    // if parent's visibility is available, that overrides 'show' flag (#12125)
    const win = BrowserWindow.fromWebContents(embedder.webContents)
    if (win != null) {
      parentOptions = {
        ...embedder.browserWindowOptions,
        show: win.isVisible()
      }
    }

    // Inherit the original options if it is a BrowserWindow.
    deepMerge(options, parentOptions)
  } else {
    // Or only inherit webPreferences if it is a webview.
    deepMerge(options.webPreferences, embedder.getLastWebPreferences())
  }

  if (key === 'type') continue
  if (key in target && key !== 'webPreferences') continue

  // Inherit certain option values from parent window
  const webPreferences: WebPreferences = embedder.getLastWebPreferences()
  for (const [name, value] of inheritedWebPreferences) {
    if (webPreferences[name] === value) {
      options.webPreferences[name] = value
    }
  }

  // Sets correct openerId here to give correct options to 'new-window' event handler
  (options.webPreferences as any).openerId = embedder.id

  return options
}

function formatPostDataWithHeaders (postData: any): undefined | { postData: any, extraHeaders: string } {
  if (!postData) return

  let extraHeaders = 'content-type: application/x-www-form-urlencoded'

  if (postData.length > 0) {
    const postDataFront = postData[0].bytes.toString()
    const boundary = /^--.*[^-\r\n]/.exec(postDataFront)
    if (boundary != null) {
      extraHeaders = `content-type: multipart/form-data; boundary=${
        boundary[0].substr(2)
      }`
    }
  }

  return {
    postData,
    extraHeaders
  }
}
