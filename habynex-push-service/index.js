const express = require('express');
const webpush = require('web-push');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================
// CLÉS VAPID HARDCODÉES
// ============================================
const VAPID_PUBLIC_KEY = "BNK59wp_qFryWsARGcefUOVfnNfoTl1D0WIrj2O1uQ4D-5UzGprgF_8gFNmuwNjheVmKZfGgxqDI1Wo6oHXxdtY";
const VAPID_PRIVATE_KEY = "2wwvxO9GDezVXg19nBMVspof_trJsjKDmT938kkTrdQ";

console.log('🔍 VAPID Public Key:', VAPID_PUBLIC_KEY.substring(0, 20) + '...');
console.log('🔍 VAPID Private Key exists:', !!VAPID_PRIVATE_KEY);

webpush.setVapidDetails(
  'mailto:contact.habynex@gmail.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

console.log('✅ Push service initialized avec clés hardcodées');

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'running', 
    timestamp: new Date().toISOString(),
    vapidConfigured: true,
    vapidPublicKeyStart: VAPID_PUBLIC_KEY.substring(0, 10) + '...'
  });
});

// Endpoint principal pour envoyer les notifications
app.post('/send', async (req, res) => {
  try {
    const { subscriptions, payload, options = {} } = req.body;
    
    console.log(`📨 Received push request for ${subscriptions?.length || 0} devices`);

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
        
        try {
          // Validation de l'abonnement
          if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
            console.warn(`⚠️ Invalid subscription format at index ${index}`);
            return { 
              success: false, 
              invalid: true, 
              index,
              error: 'Invalid subscription format' 
            };
          }

          await webpush.sendNotification(sub, JSON.stringify(payload));
          
          console.log(`✅ Push sent to ${sub.endpoint.slice(-30)} (${Date.now() - startTime}ms)`);
          
          return { 
            success: true, 
            endpoint: sub.endpoint,
            index,
            duration: Date.now() - startTime
          };

        } catch (error) {
          console.error(`❌ Push failed for ${sub.endpoint?.slice(-30)}:`, error.statusCode, error.message);
          
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

          return { 
            success: false, 
            error: error.message, 
            endpoint: sub.endpoint,
            index,
            statusCode: error.statusCode
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

    console.log(`📊 Summary: ${summary.successful} success, ${summary.failed} failed, ${summary.expired} expired`);

    res.json(summary);

  } catch (error) {
    console.error('💥 Fatal error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint pour envoyer à un seul utilisateur
app.post('/send-to-user', async (req, res) => {
  try {
    const { userId, message, data = {} } = req.body;
    
    console.log(`📨 Push to user ${userId}`);

    if (!userId || !message?.title || !message?.body) {
      return res.status(400).json({ error: 'userId, message.title and message.body required' });
    }

    if (req.body.subscriptions) {
      const result = await sendToSubscriptions(req.body.subscriptions, message, data);
      return res.json(result);
    }

    res.status(400).json({ error: 'subscriptions must be provided' });

  } catch (error) {
    console.error('💥 Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Fonction utilitaire
async function sendToSubscriptions(subscriptions, message, data) {
  const payload = {
    title: message.title,
    body: message.body,
    icon: message.icon || "/icon-192x192.png",
    badge: message.badge || "/badge-72x72.png",
    ...(message.image && { image: message.image }),
    url: data.url || "/",
    data: {
      ...data,
      timestamp: new Date().toISOString(),
    },
  };

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, JSON.stringify(payload));
        return { success: true, endpoint: sub.endpoint };
      } catch (error) {
        if (error.statusCode === 410 || error.statusCode === 404) {
          return { success: false, expired: true, endpoint: sub.endpoint };
        }
        return { success: false, error: error.message, endpoint: sub.endpoint };
      }
    })
  );

  return {
    total: results.length,
    successful: results.filter(r => r.status === 'fulfilled' && r.value.success).length,
    failed: results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length,
    expired: results.filter(r => r.status === 'fulfilled' && r.value.expired).length,
    details: results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message })
  };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Push service running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
