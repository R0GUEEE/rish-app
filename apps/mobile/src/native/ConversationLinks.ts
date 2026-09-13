import { Linking, NativeModules, Platform } from 'react-native';
import { isSafeLinkTarget } from '../markdown/inline';

type BrowserModule = {
  openConversationURL?: (request: { schema_version: 1; url: string }) => Promise<unknown>;
};

/** Open web pages without leaving the iOS app; other schemes keep OS routing. */
export async function openConversationLink(target: string): Promise<void> {
  if (!isSafeLinkTarget(target)) throw new Error('E_BROWSER_URL');
  const browser = NativeModules.LocalRuntime as BrowserModule | undefined;
  if (Platform.OS === 'ios' && /^https?:\/\//iu.test(target) &&
      typeof browser?.openConversationURL === 'function') {
    const result = await browser.openConversationURL({ schema_version: 1, url: target });
    if (typeof result !== 'object' || result === null ||
        (result as { schema_version?: unknown }).schema_version !== 1 ||
        (result as { status?: unknown }).status !== 'opened') {
      throw new Error('E_BROWSER_UNAVAILABLE');
    }
    return;
  }
  await Linking.openURL(target);
}
