const express = require('express');
const webpush = require('web-push');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Configuration VAPID
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

// DEBUG: Log des clés (tronquées pour sécurité)
console.log('🔍 DEBUG VAPID Keys:');
console.log('  Public Key exists:', !!VAPID_PUBLIC_KEY);
console.log('  Public Key length:', VAPID_PUBLIC_KEY?.length);
console.log('  Public Key start:', VAPID_PUBLIC_KEY?.substring(0, 15) + '...');
console.log('  Private Key exists:', !!VAPID_PRIVATE_KEY);
console.log('  Private Key length:', VAPID_PRIVATE_KEY?.length);

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('❌ VAPID keys missing! Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY');
  process.exit(1);
}

// Vérification du format des clés
try {
  // La clé publique doit faire 65 bytes en base64url (environ 87 caractères)
  const pubKeyBuffer = Buffer.from(VAPID_PUBLIC_KEY, 'base64url');
  console.log('  Public Key decoded length:', pubKeyBuffer.length, 'bytes (attendu: 65)');
  
  if (pubKeyBuffer.length !== 65) {
    console.warn('⚠️  La clé publique ne fait pas 65 bytes !');
  }
} catch (e) {
  console.error('❌ Erreur décodage clé publique:', e.message);
}

webpush.setVapidDetails(
  'mailto:contact.habynex@gmail.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

console.log('✅ Push service initialized');

// Health check avec debug
app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    timestamp: new Date().toISOString(),
    vapidConfigured: true,
    vapidPublicKeyStart: VAPID_PUBLIC_KEY?.substring(0, 10) + '...'
  });
});

// Endpoint principal pour envoyer les notifications
app.post('/send', async (req, res) => {
  try {
    const { subscriptions, payload, options = {} } = req.body;
    
    console.log(`\n📨 ========== NOUVELLE REQUÊTE ==========`);
    console.log(`📨 Received push request for ${subscriptions?.length || 0} devices`);
    console.log(`📨 Payload:`, JSON.stringify(payload, null, 2));

    if (!subscriptions || !Array.isArray(subscriptions) || subscriptions.length === 0) {
      return res.status(400).json({ 
        error: 'subscriptions array required and must not be empty' 
      });
    }

    if (!payload || !payload.title || !payload.body) {
      return res.status(400).json({ 
        error: 'payload with title and body required' 
      });
    }

    const results = await Promise.allSettled(
      subscriptions.map(async (sub, index) => {
        const startTime = Date.now();
        
        console.log(`\n🔔 [${index}] Traitement subscription:`);
        console.log(`   Endpoint: ${sub.endpoint?.substring(0, 50)}...`);
        console.log(`   Keys p256dh length: ${sub.keys?.p256dh?.length}`);
        console.log(`   Keys auth length: ${sub.keys?.auth?.length}`);
        
        try {
          // Validation de l'abonnement
          if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
            console.warn(`⚠️ [${index}] Invalid subscription format`);
            return { 
              success: false, 
              invalid: true, 
              index,
              error: 'Invalid subscription format' 
            };
          }

          // DEBUG: Vérifier le format de la clé p256dh
          try {
            const p256dhBuffer = Buffer.from(sub.keys.p256dh, 'base64url');
            console.log(`   p256dh decoded length: ${p256dhBuffer.length} bytes (attendu: 65)`);
          } catch (e) {
            console.error(`   ❌ Erreur décodage p256dh:`, e.message);
          }

          console.log(`   🚀 Envoi notification...`);
          
          const result = await webpush.sendNotification(sub, JSON.stringify(payload));
          
          console.log(`   ✅ SUCCÈS (${Date.now() - startTime}ms) - Status: ${result.statusCode}`);
          
          return { 
            success: true, 
            endpoint: sub.endpoint,
            index,
            duration: Date.now() - startTime,
            statusCode: result.statusCode
          };

        } catch (error) {
          console.error(`\n   ❌ ERREUR [${index}]:`);
          console.error(`   Status Code: ${error.statusCode}`);
          console.error(`   Message: ${error.message}`);
          console.error(`   Body: ${error.body}`);
          console.error(`   Stack: ${error.stack?.substring(0, 200)}...`);
          
          // Token expiré ou invalide
          if (error.statusCode === 410 || error.statusCode === 404) {
            return { 
              success: false, 
              expired: true, 
              endpoint: sub.endpoint,
              index,
              statusCode: error.statusCode
            };
          }

          // Erreur 403 spécifique
          if (error.statusCode === 403) {
            console.error(`\n   🔴 ERREUR 403 DÉTECTÉE !`);
            console.error(`   Cela signifie que les clés VAPID ne correspondent pas.`);
            console.error(`   Clé VAPID utilisée (serveur): ${VAPID_PUBLIC_KEY?.substring(0, 20)}...`);
            console.error(`   Vérifie que cette clé correspond à celle utilisée côté client.`);
          }

          return { 
            success: false, 
            error: error.message, 
            endpoint: sub.endpoint,
            index,
            statusCode: error.statusCode,
            body: error.body
          };
        }
      })
    );

    const summary = {
      total: results.length,
      successful: results.filter(r => r.status === 'fulfilled' && r.value.success).length,
      failed: results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length,
      expired: results.filter(r => r.status === 'fulfilled' && r.value.expired).length,
      invalid: results.filter(r => r.status === 'fulfilled' && r.value.invalid).length,
      details: results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message })
    };

    console.log(`\n📊 ========== RÉSUMÉ ==========`);
    console.log(`   Total: ${summary.total}`);
    console.log(`   Succès: ${summary.successful}`);
    console.log(`   Échecs: ${summary.failed}`);
    console.log(`   Expirés: ${summary.expired}`);
    console.log(`   =============================\n`);

    res.json(summary);

  } catch (error) {
    console.error('💥 Fatal error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ... reste du code inchangé ...

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Push service running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
