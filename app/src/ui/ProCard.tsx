import React, { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import type { PurchasesPackage } from 'react-native-purchases';

import { getPackages, purchasePackage, purchasesAvailable, restorePurchases, useProStatus } from '../api/purchases';
import { Button, Card } from './components';
import { space, type } from './theme';

/** Soloist Pro upgrade / status card, backed by RevenueCat. */
export function ProCard() {
  const { isPro, loading } = useProStatus();
  const [packages, setPackages] = useState<PurchasesPackage[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isPro) getPackages().then(setPackages);
  }, [isPro]);

  const run = async (fn: () => Promise<boolean>, okMsg: string, noneMsg?: string) => {
    setBusy(true);
    try {
      const ok = await fn();
      if (ok) Alert.alert('Soloist Pro', okMsg);
      else if (noneMsg) Alert.alert('Soloist Pro', noneMsg);
    } catch (e: any) {
      Alert.alert('Something went wrong', e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!purchasesAvailable()) {
    return (
      <Card>
        <Text style={type.small}>Purchases aren't set up in this build.</Text>
      </Card>
    );
  }

  return (
    <Card style={{ gap: space(3) }}>
      <Text style={type.body}>
        {loading ? 'Checking your plan…' : isPro ? 'Soloist Pro is active. Thanks for supporting Soloist!' : 'Unlock everything with Soloist Pro.'}
      </Text>
      {!isPro && (
        <View style={{ gap: space(2) }}>
          {packages.map((p) => (
            <Button
              key={p.identifier}
              label={`${p.product.title} · ${p.product.priceString}`}
              disabled={busy}
              onPress={() => run(() => purchasePackage(p), 'Welcome to Pro!')}
            />
          ))}
          <Button
            label="Restore purchases"
            variant="secondary"
            disabled={busy}
            onPress={() => run(restorePurchases, 'Your purchase has been restored.', 'No previous purchase found.')}
          />
        </View>
      )}
    </Card>
  );
}
