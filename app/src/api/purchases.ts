import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import Purchases, { CustomerInfo, LOG_LEVEL, PurchasesPackage } from 'react-native-purchases';

/** Public SDK keys from the RevenueCat dashboard (Project → API keys). Safe to ship in the app. */
const API_KEYS = {
  android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY ?? '',
  ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY ?? '',
};

export const ENTITLEMENT_ID = 'pro';

let configured = false;

const hasPro = (info: CustomerInfo) => Boolean(info.entitlements.active[ENTITLEMENT_ID]);

/** Call once at startup. No-ops (and leaves the app fully usable) when no key is set. */
export const initPurchases = (appUserID?: string) => {
  if (configured) return;
  const apiKey = Platform.OS === 'ios' ? API_KEYS.ios : API_KEYS.android;
  if (!apiKey) {
    console.warn('[purchases] No RevenueCat API key set; purchases disabled.');
    return;
  }
  if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  Purchases.configure({ apiKey, appUserID });
  configured = true;
};

export const purchasesAvailable = () => configured;

export const getPackages = async (): Promise<PurchasesPackage[]> => {
  if (!configured) return [];
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current?.availablePackages ?? [];
  } catch (e) {
    console.warn('[purchases] Failed to fetch offerings', e);
    return [];
  }
};

/** Returns true if the purchase unlocked Pro. Throws on real failures; resolves false on user cancel. */
export const purchasePackage = async (pkg: PurchasesPackage): Promise<boolean> => {
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return hasPro(customerInfo);
  } catch (e: any) {
    if (e?.userCancelled) return false;
    throw e;
  }
};

export const restorePurchases = async (): Promise<boolean> => hasPro(await Purchases.restorePurchases());

/** Live Pro status; updates when RevenueCat pushes new customer info (purchase, restore, renewal). */
export function useProStatus() {
  const [isPro, setIsPro] = useState(false);
  const [loading, setLoading] = useState(configured);

  useEffect(() => {
    if (!configured) return;
    const onInfo = (info: CustomerInfo) => setIsPro(hasPro(info));
    Purchases.getCustomerInfo()
      .then(onInfo)
      .catch((e) => console.warn('[purchases] Failed to fetch customer info', e))
      .finally(() => setLoading(false));
    Purchases.addCustomerInfoUpdateListener(onInfo);
    return () => {
      Purchases.removeCustomerInfoUpdateListener(onInfo);
    };
  }, []);

  return { isPro, loading };
}
