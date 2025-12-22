// IMAP MCP Pro - Tile-based Dashboard UI
// Author: Colin Bitterfield
// Email: colin@bitterfield.com
// Version: 2.13.0

// View Management
function hideAllViews() {
  document.getElementById('dashboardView').classList.add('hidden');
  document.getElementById('profileView').classList.add('hidden');
  document.getElementById('accountsView').classList.add('hidden');
  document.getElementById('dnsFirewallView').classList.add('hidden');
  document.getElementById('spamCheckView').classList.add('hidden');
  document.getElementById('categoriesView').classList.add('hidden');
  document.getElementById('rulesView').classList.add('hidden');
}

function showDashboard() {
  hideAllViews();
  document.getElementById('dashboardView').classList.remove('hidden');
}

function showProfile() {
  hideAllViews();
  document.getElementById('profileView').classList.remove('hidden');
  loadProfile();
}

function showAccounts() {
  hideAllViews();
  document.getElementById('accountsView').classList.remove('hidden');
  loadAccountsUI();
}

function showDnsFirewall() {
  hideAllViews();
  document.getElementById('dnsFirewallView').classList.remove('hidden');
  loadDnsProviders();
}

function showSpamCheck() {
  hideAllViews();
  document.getElementById('spamCheckView').classList.remove('hidden');
  loadUserCheckKeys();
}

function showCategories() {
  hideAllViews();
  document.getElementById('categoriesView').classList.remove('hidden');
  loadCategoryAccounts();
}

function showRules() {
  hideAllViews();
  document.getElementById('rulesView').classList.remove('hidden');
}

// Profile Management
async function loadProfile() {
  try {
    const response = await fetch('/api/profile');
    const result = await response.json();

    if (result.success && result.profile) {
      document.getElementById('profileUserId').textContent = result.profile.userId;
      document.getElementById('profileDbPath').textContent = result.profile.databasePath;
      document.getElementById('profileDbSize').textContent = formatBytes(result.profile.databaseSize);
      document.getElementById('profileVersion').textContent = result.profile.version;
    }
  } catch (error) {
    console.error('Failed to load profile:', error);
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// DNS Firewall Management
// DNS Provider Presets
let dnsProviderPresets = [];

async function loadDnsProviderPresets() {
  try {
    const response = await fetch('/api/dns-providers');
    dnsProviderPresets = await response.json();

    // Populate dropdown
    const select = document.getElementById('dnsProviderSelect');
    select.innerHTML = '<option value="">-- Choose a DNS Provider --</option>';

    dnsProviderPresets.forEach(provider => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.displayName;
      if (provider.id === 'quad9') {
        option.textContent += ' ⭐';
      }
      select.appendChild(option);
    });
  } catch (error) {
    console.error('Failed to load DNS provider presets:', error);
  }
}

function onDnsProviderChange() {
  const providerId = document.getElementById('dnsProviderSelect').value;
  const provider = dnsProviderPresets.find(p => p.id === providerId);

  if (provider && provider.id !== 'custom') {
    document.getElementById('dnsProviderDetails').classList.remove('hidden');

    // Populate provider details
    document.getElementById('selectedProviderName').textContent = provider.displayName;
    document.getElementById('selectedProviderDescription').textContent = provider.description;
    document.getElementById('selectedPrimaryDNS').textContent = provider.primaryDNS;
    document.getElementById('selectedSecondaryDNS').textContent = provider.secondaryDNS;
    document.getElementById('dnsProviderName').value = provider.name;

    // Display features as badges
    const featuresDiv = document.getElementById('selectedFeatures');
    featuresDiv.innerHTML = '';

    if (provider.features.malwareBlocking) {
      featuresDiv.innerHTML += '<span class="text-xs bg-red-100 text-red-800 px-2 py-1 rounded">Malware Blocking</span>';
    }
    if (provider.features.adBlocking) {
      featuresDiv.innerHTML += '<span class="text-xs bg-orange-100 text-orange-800 px-2 py-1 rounded">Ad Blocking</span>';
    }
    if (provider.features.adultContentFiltering) {
      featuresDiv.innerHTML += '<span class="text-xs bg-purple-100 text-purple-800 px-2 py-1 rounded">Adult Content Filter</span>';
    }
    if (provider.features.dnssec) {
      featuresDiv.innerHTML += '<span class="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">DNSSEC</span>';
    }
    if (provider.features.noLogging) {
      featuresDiv.innerHTML += '<span class="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">No Logging</span>';
    }
    if (provider.features.encrypted) {
      featuresDiv.innerHTML += '<span class="text-xs bg-indigo-100 text-indigo-800 px-2 py-1 rounded">Encrypted (DoH/DoT)</span>';
    }
  } else if (provider && provider.id === 'custom') {
    document.getElementById('dnsProviderDetails').classList.remove('hidden');
    document.getElementById('selectedProviderName').textContent = 'Custom DNS Server';
    document.getElementById('selectedProviderDescription').textContent = 'Enter custom DNS server addresses';
    document.getElementById('selectedPrimaryDNS').textContent = 'Not set';
    document.getElementById('selectedSecondaryDNS').textContent = 'Not set';
    document.getElementById('selectedFeatures').innerHTML = '';
    document.getElementById('dnsProviderName').value = '';
  } else {
    document.getElementById('dnsProviderDetails').classList.add('hidden');
  }
}

async function addDnsProviderFromPreset() {
  const providerId = document.getElementById('dnsProviderSelect').value;
  const providerName = document.getElementById('dnsProviderName').value;
  const apiKey = document.getElementById('dnsProviderApiKey').value;

  if (!providerId) {
    alert('Please select a DNS provider');
    return;
  }

  const provider = dnsProviderPresets.find(p => p.id === providerId);
  if (!provider) {
    alert('Invalid provider selected');
    return;
  }

  try {
    const response = await fetch('/api/dns-firewall/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerType: 'quad9',
        providerName: providerName || provider.name,
        apiEndpoint: `https://dns.quad9.net:5053/dns-query`,
        apiKey: apiKey || '',
        timeoutMs: 5000,
        isEnabled: true,
        isDefault: false
      })
    });

    const result = await response.json();

    if (result.success) {
      alert('✅ DNS provider added successfully!');
      document.getElementById('dnsProviderSelect').value = '';
      document.getElementById('dnsProviderDetails').classList.add('hidden');
      loadDnsProviders();
    } else {
      alert('❌ Failed to add provider: ' + result.error);
    }
  } catch (error) {
    alert('❌ Error: ' + error.message);
  }
}

async function loadDnsProviders() {
  // Load presets if not already loaded
  if (dnsProviderPresets.length === 0) {
    await loadDnsProviderPresets();
  }

  try {
    const response = await fetch('/api/dns-firewall/providers');
    const result = await response.json();

    if (result.success && result.providers) {
      const container = document.getElementById('dnsProvidersList');

      if (result.providers.length === 0) {
        container.innerHTML = '<p class="text-sm text-gray-500">No DNS firewall providers configured</p>';
      } else {
        container.innerHTML = result.providers.map(provider => {
          const statusBadge = provider.isEnabled
            ? '<span class="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">Enabled</span>'
            : '<span class="text-xs bg-gray-100 text-gray-800 px-2 py-1 rounded">Disabled</span>';

          const defaultBadge = provider.isDefault
            ? '<span class="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded ml-2">Default</span>'
            : '';

          return `
            <div class="border border-gray-200 rounded-lg p-4 mb-4 bg-white">
              <div class="mb-4">
                <div class="flex items-center justify-between mb-2">
                  <div class="flex items-center">
                    <h5 class="font-semibold text-lg">${provider.providerName}</h5>
                    ${statusBadge}
                    ${defaultBadge}
                  </div>
                  <div class="flex gap-2">
                    <button onclick="testDnsProvider('${provider.providerId}')" class="text-gray-600 hover:text-gray-800 text-sm">
                      Test
                    </button>
                    <button onclick="editDnsProvider('${provider.providerId}')" class="text-blue-600 hover:text-blue-800 text-sm">
                      Edit
                    </button>
                  </div>
                </div>
                <p class="text-xs text-gray-500">Type: ${provider.providerType}</p>
                <p class="text-xs text-gray-500">Endpoint: ${provider.apiEndpoint}</p>
                ${provider.apiKey ? '<p class="text-xs text-gray-500">API Key: ••••••••</p>' : ''}
              </div>

              <div class="grid grid-cols-3 gap-4 pt-4 border-t border-gray-200">
                <div>
                  <label class="flex items-center cursor-pointer">
                    <input type="checkbox"
                      ${provider.isEnabled ? 'checked' : ''}
                      onchange="toggleDnsProvider('${provider.providerId}', this.checked)"
                      class="mr-2 cursor-pointer">
                    <span class="text-sm font-medium">Enabled</span>
                  </label>
                  <p class="text-xs text-gray-500 mt-1">Use this provider</p>
                </div>

                <div>
                  <label class="flex items-center cursor-pointer">
                    <input type="checkbox"
                      ${provider.isDefault ? 'checked' : ''}
                      onchange="setDefaultDnsProvider('${provider.providerId}', this.checked)"
                      class="mr-2 cursor-pointer">
                    <span class="text-sm font-medium">Default</span>
                  </label>
                  <p class="text-xs text-gray-500 mt-1">Primary provider</p>
                </div>

                <div>
                  <div class="flex items-center">
                    <label class="text-sm font-medium mr-2">Timeout:</label>
                    <input type="number"
                      value="${provider.timeoutMs}"
                      onchange="updateDnsProviderTimeout('${provider.providerId}', this.value)"
                      class="w-20 px-2 py-1 border border-gray-300 rounded text-sm">
                    <span class="text-xs text-gray-500 ml-1">ms</span>
                  </div>
                  <p class="text-xs text-gray-500 mt-1">Query timeout</p>
                </div>
              </div>

              <div id="dns-test-result-${provider.providerId}" class="hidden mt-4 pt-4 border-t border-gray-200"></div>
            </div>
          `;
        }).join('');
      }
    }
  } catch (error) {
    console.error('Failed to load DNS providers:', error);
  }
}

async function toggleDnsProvider(providerId, isEnabled) {
  try {
    const response = await fetch(`/api/dns-firewall/providers/${providerId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isEnabled })
    });

    const result = await response.json();
    if (result.success) {
      loadDnsProviders();
    }
  } catch (error) {
    console.error('Failed to update DNS provider:', error);
  }
}

async function setDefaultDnsProvider(providerId, isDefault) {
  try {
    const response = await fetch(`/api/dns-firewall/providers/${providerId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefault })
    });

    const result = await response.json();
    if (result.success) {
      loadDnsProviders();
    }
  } catch (error) {
    console.error('Failed to update DNS provider:', error);
  }
}

async function updateDnsProviderTimeout(providerId, timeoutMs) {
  try {
    const timeout = parseInt(timeoutMs);
    if (isNaN(timeout) || timeout < 1000 || timeout > 30000) {
      alert('Timeout must be between 1000 and 30000 milliseconds');
      loadDnsProviders();
      return;
    }

    const response = await fetch(`/api/dns-firewall/providers/${providerId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeoutMs: timeout })
    });

    const result = await response.json();
    if (result.success) {
      loadDnsProviders();
    }
  } catch (error) {
    console.error('Failed to update DNS provider timeout:', error);
  }
}

function editDnsProvider(providerId) {
  const providerName = prompt('Edit DNS Provider\n\nProvider name:');
  if (!providerName) return;

  const apiEndpoint = prompt('API Endpoint:');
  if (!apiEndpoint) return;

  const apiKey = prompt('API Key (leave empty if not required):');

  updateDnsProviderDetails(providerId, providerName, apiEndpoint, apiKey);
}

async function updateDnsProviderDetails(providerId, providerName, apiEndpoint, apiKey) {
  try {
    const updates = { providerName, apiEndpoint };
    if (apiKey) {
      updates.apiKey = apiKey;
    }

    const response = await fetch(`/api/dns-firewall/providers/${providerId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });

    const result = await response.json();
    if (result.success) {
      loadDnsProviders();
    } else {
      alert('Failed to update provider: ' + result.error);
    }
  } catch (error) {
    console.error('Failed to update DNS provider:', error);
    alert('Failed to update provider');
  }
}

async function testDnsProvider(providerId) {
  const resultDiv = document.getElementById(`dns-test-result-${providerId}`);
  resultDiv.classList.remove('hidden');
  resultDiv.innerHTML = '<div class="text-gray-600 text-sm">Testing DNS provider...</div>';

  try {
    const response = await fetch(`/api/dns-firewall/providers/${providerId}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'google.com' })
    });

    const result = await response.json();

    if (result.success) {
      resultDiv.innerHTML = `
        <div class="bg-green-50 border border-green-200 rounded p-3 text-sm">
          <div class="flex items-center mb-2">
            <span class="text-green-600 font-semibold">✓ DNS Query Successful</span>
          </div>
          <p class="text-gray-700">Test domain: <span class="font-mono">google.com</span></p>
          ${result.blocked !== undefined ? `<p class="text-gray-700">Blocked: <span class="font-semibold ${result.blocked ? 'text-red-600' : 'text-green-600'}">${result.blocked ? 'Yes' : 'No'}</span></p>` : ''}
          ${result.responseTime ? `<p class="text-gray-600">Response time: ${result.responseTime}ms</p>` : ''}
          ${result.addresses ? `<p class="text-gray-600 mt-1">Resolved: ${result.addresses.join(', ')}</p>` : ''}
        </div>
      `;
    } else {
      resultDiv.innerHTML = `
        <div class="bg-red-50 border border-red-200 rounded p-3 text-sm">
          <span class="text-red-600 font-semibold">✗ DNS Query Failed</span>
          <p class="text-red-700 mt-1">${result.error || 'Unknown error'}</p>
        </div>
      `;
    }
  } catch (error) {
    resultDiv.innerHTML = `
      <div class="bg-red-50 border border-red-200 rounded p-3 text-sm">
        <span class="text-red-600 font-semibold">✗ Test Failed</span>
        <p class="text-red-700 mt-1">${error.message}</p>
      </div>
    `;
  }
}

// UserCheck / SPAM Check Management
async function loadUserCheckKeys() {
  try {
    const response = await fetch('/api/usercheck/keys');
    const result = await response.json();

    if (result.success && result.keys) {
      const container = document.getElementById('userCheckKeysList');

      if (result.keys.length === 0) {
        container.innerHTML = `
          <p class="text-sm text-gray-500 mb-4">No UserCheck API keys configured</p>
          <button onclick="addUserCheckKey()" class="bg-red-600 text-white px-4 py-2 rounded-md hover:bg-red-700">
            Add API Key
          </button>
        `;
      } else {
        container.innerHTML = result.keys.map(key => {
          const statusBadge = key.isActive
            ? '<span class="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">Active</span>'
            : '<span class="text-xs bg-gray-100 text-gray-800 px-2 py-1 rounded">Inactive</span>';

          return `
            <div class="border border-gray-200 rounded-lg p-4 mb-4">
              <div class="flex justify-between items-start">
                <div class="flex-1">
                  <div class="flex items-center mb-2">
                    <h5 class="font-semibold">UserCheck API Key</h5>
                    ${statusBadge}
                  </div>
                  <p class="text-xs text-gray-500 font-mono">Key: ${key.apiKey.substring(0, 10)}...${key.apiKey.substring(key.apiKey.length - 4)}</p>
                  <div class="mt-2 text-xs text-gray-600">
                    <p>Daily Usage: ${key.dailyUsage} / ${key.dailyLimit}</p>
                    ${key.lastUsed ? `<p>Last Used: ${new Date(key.lastUsed).toLocaleString()}</p>` : ''}
                  </div>
                </div>
                <div class="flex gap-2">
                  <button onclick="testUserCheckKey(${key.id})" class="text-gray-600 hover:text-gray-800 text-sm">
                    Test
                  </button>
                  <button onclick="deleteUserCheckKey(${key.id})" class="text-red-600 hover:text-red-800 text-sm">
                    Delete
                  </button>
                </div>
              </div>
              <div id="usercheck-test-result-${key.id}" class="hidden mt-4 pt-4 border-t border-gray-200"></div>
            </div>
          `;
        }).join('');

        container.innerHTML += `
          <button onclick="addUserCheckKey()" class="bg-red-600 text-white px-4 py-2 rounded-md hover:bg-red-700 mt-4">
            Add Another API Key
          </button>
        `;
      }
    }
  } catch (error) {
    console.error('Failed to load UserCheck keys:', error);
  }
}

function addUserCheckKey() {
  const apiKey = prompt('Enter UserCheck API key:');
  if (!apiKey) return;

  saveUserCheckKey(apiKey);
}

async function saveUserCheckKey(apiKey) {
  try {
    const response = await fetch('/api/usercheck/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, isActive: true })
    });

    const result = await response.json();
    if (result.success) {
      loadUserCheckKeys();
    } else {
      alert('Failed to save API key: ' + result.error);
    }
  } catch (error) {
    console.error('Failed to save UserCheck key:', error);
    alert('Failed to save API key');
  }
}

async function deleteUserCheckKey(keyId) {
  if (!confirm('Delete this UserCheck API key?')) return;

  try {
    const response = await fetch(`/api/usercheck/keys/${keyId}`, {
      method: 'DELETE'
    });

    const result = await response.json();
    if (result.success) {
      loadUserCheckKeys();
    } else {
      alert('Failed to delete API key: ' + result.error);
    }
  } catch (error) {
    console.error('Failed to delete UserCheck key:', error);
    alert('Failed to delete API key');
  }
}

async function testUserCheckKey(keyId) {
  const resultDiv = document.getElementById(`usercheck-test-result-${keyId}`);
  resultDiv.classList.remove('hidden');
  resultDiv.innerHTML = '<div class="text-gray-600 text-sm">Testing UserCheck API...</div>';

  // Test with a known disposable email domain
  const testEmail = 'test@tempmail.com';

  try {
    const response = await fetch('/api/usercheck/check-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        checkDisposable: true,
        checkBlocklisted: true
      })
    });

    const result = await response.json();

    if (result.success) {
      resultDiv.innerHTML = `
        <div class="bg-green-50 border border-green-200 rounded p-3 text-sm">
          <div class="flex items-center mb-2">
            <span class="text-green-600 font-semibold">✓ UserCheck API Working</span>
          </div>
          <p class="text-gray-700">Test email: <span class="font-mono">${testEmail}</span></p>
          ${result.result?.disposable !== undefined ? `<p class="text-gray-700">Disposable: <span class="font-semibold ${result.result.disposable ? 'text-red-600' : 'text-green-600'}">${result.result.disposable ? 'Yes' : 'No'}</span></p>` : ''}
          ${result.result?.blocklisted !== undefined ? `<p class="text-gray-700">Blocklisted: <span class="font-semibold ${result.result.blocklisted ? 'text-red-600' : 'text-green-600'}">${result.result.blocklisted ? 'Yes' : 'No'}</span></p>` : ''}
          <p class="text-gray-600 text-xs mt-2">API call successful - key is valid</p>
        </div>
      `;
    } else {
      resultDiv.innerHTML = `
        <div class="bg-red-50 border border-red-200 rounded p-3 text-sm">
          <span class="text-red-600 font-semibold">✗ UserCheck API Failed</span>
          <p class="text-red-700 mt-1">${result.error || 'Unknown error'}</p>
        </div>
      `;
    }
  } catch (error) {
    resultDiv.innerHTML = `
      <div class="bg-red-50 border border-red-200 rounded p-3 text-sm">
        <span class="text-red-600 font-semibold">✗ Test Failed</span>
        <p class="text-red-700 mt-1">${error.message}</p>
      </div>
    `;
  }
}

// Categories Management
async function loadCategoryAccounts() {
  try {
    const response = await fetch('/api/accounts');
    const result = await response.json();

    if (result.success && result.accounts) {
      const select = document.getElementById('categoryAccountSelect');
      select.innerHTML = '<option value="">Select an account...</option>' +
        result.accounts.map(acc =>
          `<option value="${acc.id}">${acc.email}</option>`
        ).join('');
    }
  } catch (error) {
    console.error('Failed to load accounts:', error);
  }
}

async function loadCategories() {
  const accountId = document.getElementById('categoryAccountSelect').value;
  if (!accountId) {
    document.getElementById('categoriesList').innerHTML = '<p class="text-sm text-gray-500 text-center py-8">Select an account to view categories</p>';
    return;
  }

  try {
    const response = await fetch(`/api/categories?accountId=${accountId}`);
    const result = await response.json();

    if (result.success && result.categories) {
      const container = document.getElementById('categoriesList');

      if (result.categories.length === 0) {
        container.innerHTML = '<p class="text-sm text-gray-500 text-center py-8">No categories configured for this account</p>';
      } else {
        container.innerHTML = '<div class="space-y-3">' + result.categories.map(cat => `
          <div class="border ${cat.enabled ? 'border-purple-300 bg-purple-50' : 'border-gray-200 bg-gray-50'} rounded-lg p-4">
            <div class="flex justify-between items-start mb-2">
              <div class="flex-1">
                <div class="flex items-center gap-2 mb-1">
                  <h5 class="font-semibold text-lg ${cat.enabled ? 'text-purple-900' : 'text-gray-500'}">${cat.categoryName}</h5>
                  <span class="px-2 py-1 text-xs rounded ${cat.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'}">
                    ${cat.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <div class="space-y-1 text-sm">
                  <p class="text-gray-700">
                    <i class="fas fa-tags mr-1"></i><strong>Keywords:</strong>
                    <span class="text-gray-600">${cat.keywords}</span>
                  </p>
                  <p class="text-gray-700">
                    <i class="fas fa-folder mr-1"></i><strong>Folder:</strong>
                    <span class="text-gray-600">${cat.targetFolder}</span>
                  </p>
                  ${cat.matchCount > 0 ? `
                    <p class="text-gray-600 text-xs">
                      <i class="fas fa-check-circle mr-1"></i>Matched ${cat.matchCount} email${cat.matchCount !== 1 ? 's' : ''}
                      ${cat.lastMatched ? ` (last: ${new Date(cat.lastMatched).toLocaleString()})` : ''}
                    </p>
                  ` : ''}
                </div>
              </div>
              <div class="flex gap-2 ml-4">
                <button onclick="toggleCategory(${cat.categoryId}, ${!cat.enabled})"
                        class="px-3 py-1 text-sm rounded ${cat.enabled ? 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200' : 'bg-green-100 text-green-700 hover:bg-green-200'}">
                  <i class="fas ${cat.enabled ? 'fa-pause' : 'fa-play'} mr-1"></i>${cat.enabled ? 'Disable' : 'Enable'}
                </button>
                <button onclick="deleteCategory(${cat.categoryId})"
                        class="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200">
                  <i class="fas fa-trash mr-1"></i>Delete
                </button>
              </div>
            </div>
          </div>
        `).join('') + '</div>';
      }
    }
  } catch (error) {
    console.error('Failed to load categories:', error);
    document.getElementById('categoriesList').innerHTML = '<p class="text-sm text-red-500 text-center py-8">Failed to load categories</p>';
  }
}

async function addCategory() {
  const accountId = document.getElementById('categoryAccountSelect').value;
  const categoryName = document.getElementById('newCategoryName').value.trim();
  const keywords = document.getElementById('newCategoryKeywords').value.trim();
  const targetFolder = document.getElementById('newCategoryFolder').value.trim();
  const enabled = document.getElementById('newCategoryEnabled').checked;

  if (!accountId) {
    alert('Please select an account first');
    return;
  }

  if (!categoryName || !keywords || !targetFolder) {
    alert('Please fill in all required fields: Category Name, Keywords, and Target Folder');
    return;
  }

  try {
    const response = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId,
        categoryName,
        keywords,
        targetFolder,
        enabled
      })
    });

    const result = await response.json();
    if (result.success) {
      document.getElementById('newCategoryName').value = '';
      document.getElementById('newCategoryKeywords').value = '';
      document.getElementById('newCategoryFolder').value = '';
      document.getElementById('newCategoryEnabled').checked = true;
      loadCategories();
      alert('Category created successfully!');
    } else {
      alert('Failed to add category: ' + result.error);
    }
  } catch (error) {
    console.error('Failed to add category:', error);
    alert('Failed to add category');
  }
}

async function toggleCategory(categoryId, enabled) {
  try {
    const response = await fetch(`/api/categories/${categoryId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });

    const result = await response.json();
    if (result.success) {
      loadCategories();
    } else {
      alert('Failed to toggle category: ' + result.error);
    }
  } catch (error) {
    console.error('Failed to toggle category:', error);
    alert('Failed to toggle category');
  }
}

async function deleteCategory(categoryId) {
  if (!confirm('Delete this category?')) return;

  try {
    const response = await fetch(`/api/categories/${categoryId}`, {
      method: 'DELETE'
    });

    const result = await response.json();
    if (result.success) {
      loadCategories();
    } else {
      alert('Failed to delete category: ' + result.error);
    }
  } catch (error) {
    console.error('Failed to delete category:', error);
    alert('Failed to delete category');
  }
}

// Accounts Management
let emailProviders = [];
let currentEditingAccountId = null;

async function loadEmailProviders() {
  try {
    const response = await fetch('/api/providers');
    emailProviders = await response.json();

    // Populate provider dropdown
    const providerSelect = document.getElementById('accountProvider');
    providerSelect.innerHTML = '<option value="">-- Select Provider (or enter custom) --</option>';

    emailProviders.forEach(provider => {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.displayName;
      providerSelect.appendChild(option);
    });
  } catch (error) {
    console.error('Failed to load email providers:', error);
  }
}

function onProviderChange() {
  const providerId = document.getElementById('accountProvider').value;
  const provider = emailProviders.find(p => p.id === providerId);

  if (provider && provider.id !== 'custom') {
    // Auto-fill IMAP settings
    document.getElementById('accountImapHost').value = provider.imapHost;
    document.getElementById('accountImapPort').value = provider.imapPort;

    // Auto-fill SMTP settings if available
    if (provider.smtpHost) {
      document.getElementById('smtpEnabled').checked = true;
      document.getElementById('accountSmtpHost').value = provider.smtpHost;
      document.getElementById('accountSmtpPort').value = provider.smtpPort || 465;
      document.getElementById('accountSmtpSecure').checked = provider.smtpSecurity !== 'STARTTLS';
      document.getElementById('smtpDetails').style.display = 'block';
    }

    // Show provider notes if available
    if (provider.requiresAppPassword || provider.notes) {
      const notesEl = document.getElementById('providerNotes');
      notesEl.textContent = provider.notes || 'Note: This provider may require an app-specific password';
      notesEl.classList.remove('hidden');
    } else {
      document.getElementById('providerNotes').classList.add('hidden');
    }
  } else {
    // Clear provider notes for custom/manual entry
    document.getElementById('providerNotes').classList.add('hidden');
  }
}

function onEmailChange() {
  const email = document.getElementById('accountEmail').value;
  const domain = email.split('@')[1];

  if (!domain) return;

  // Auto-detect provider from email domain
  const provider = emailProviders.find(p =>
    p.domains && p.domains.some(d => domain.toLowerCase().endsWith(d.toLowerCase()))
  );

  if (provider) {
    document.getElementById('accountProvider').value = provider.id;
    onProviderChange();
    showAccountFormMessage(`✓ Detected ${provider.displayName}`, 'success');
  }
}

function onSmtpToggle() {
  const smtpEnabled = document.getElementById('smtpEnabled').checked;
  const smtpDetails = document.getElementById('smtpDetails');

  if (smtpEnabled) {
    smtpDetails.style.display = 'block';
  } else {
    smtpDetails.style.display = 'none';
  }
}

async function loadAccountsUI() {
  document.getElementById('accountsList').classList.remove('hidden');
  document.getElementById('accountFormView').classList.add('hidden');
  await loadAccountsList();
}

async function loadAccountsList() {
  try {
    const response = await fetch('/api/accounts');
    const accounts = await response.json();

    const container = document.getElementById('accountsListContent');

    if (Array.isArray(accounts) && accounts.length > 0) {
      container.innerHTML = '<div class="space-y-2">' + accounts.map(acc => `
        <div class="border border-gray-200 rounded-lg p-4" id="account-${acc.id}">
          <div class="flex justify-between items-start">
            <div>
              <h5 class="font-semibold">${acc.user}</h5>
              <p class="text-sm text-gray-500">Name: ${acc.name}</p>
              <p class="text-sm text-gray-500">Host: ${acc.host}:${acc.port}</p>
              <span class="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">Configured</span>
            </div>
            <div class="flex gap-2">
              <button onclick="editAccount('${acc.id}')" class="text-blue-600 hover:text-blue-800 text-sm">
                Edit
              </button>
              <button onclick="testSingleAccount('${acc.id}')" class="text-gray-600 hover:text-gray-800 text-sm">
                Test
              </button>
              <button onclick="connectAccount('${acc.id}')" class="text-blue-600 hover:text-blue-800 text-sm">
                Connect
              </button>
              <button onclick="deleteAccount('${acc.id}')" class="text-red-600 hover:text-red-800 text-sm">
                Delete
              </button>
            </div>
          </div>
          <div id="test-result-${acc.id}" class="hidden mt-3 text-sm"></div>
        </div>
      `).join('') + '</div>';
    } else {
      container.innerHTML = '<p class="text-gray-500">No accounts configured. Click "Add Account" to get started.</p>';
    }
  } catch (error) {
    console.error('Failed to load accounts:', error);
    document.getElementById('accountsListContent').innerHTML = '<p class="text-red-500">Failed to load accounts</p>';
  }
}

async function startAddAccount() {
  currentEditingAccountId = null;
  document.getElementById('accountsList').classList.add('hidden');
  document.getElementById('accountFormView').classList.remove('hidden');
  document.getElementById('formTitle').textContent = 'Add New Account';

  // Load email providers if not already loaded
  if (emailProviders.length === 0) {
    await loadEmailProviders();
  }

  // Clear form
  document.getElementById('accountProvider').value = '';
  document.getElementById('accountEmail').value = '';
  document.getElementById('accountPassword').value = '';
  document.getElementById('accountImapHost').value = '';
  document.getElementById('accountImapPort').value = '993';
  document.getElementById('accountSmtpHost').value = '';
  document.getElementById('accountSmtpPort').value = '465';
  document.getElementById('smtpEnabled').checked = true;
  document.getElementById('accountSmtpSecure').checked = true;
  document.getElementById('providerNotes').classList.add('hidden');
  document.getElementById('accountFormMessage').classList.add('hidden');
  document.getElementById('smtpDetails').style.display = 'block';
}

async function editAccount(accountId) {
  try {
    // Fetch full account details
    const response = await fetch('/api/accounts');
    const accounts = await response.json();
    const account = accounts.find(acc => acc.id === accountId);

    if (!account) {
      alert('Account not found');
      return;
    }

    currentEditingAccountId = accountId;
    document.getElementById('accountsList').classList.add('hidden');
    document.getElementById('accountFormView').classList.remove('hidden');
    document.getElementById('formTitle').textContent = 'Edit Account';

    // Load email providers if not already loaded
    if (emailProviders.length === 0) {
      await loadEmailProviders();
    }

    // Populate form with existing data
    document.getElementById('accountProvider').value = '';  // Can't auto-detect provider from existing data
    document.getElementById('accountEmail').value = account.user || '';
    document.getElementById('accountPassword').value = '';  // Don't show password for security
    document.getElementById('accountImapHost').value = account.host || '';
    document.getElementById('accountImapPort').value = account.port || '993';

    // Populate SMTP fields if present
    if (account.smtp && account.smtp.host) {
      document.getElementById('smtpEnabled').checked = true;
      document.getElementById('accountSmtpHost').value = account.smtp.host || '';
      document.getElementById('accountSmtpPort').value = account.smtp.port || '465';
      document.getElementById('accountSmtpSecure').checked = account.smtp.tls || false;
      document.getElementById('smtpDetails').style.display = 'block';
    } else {
      document.getElementById('smtpEnabled').checked = false;
      document.getElementById('accountSmtpHost').value = '';
      document.getElementById('accountSmtpPort').value = '465';
      document.getElementById('accountSmtpSecure').checked = true;
      document.getElementById('smtpDetails').style.display = 'none';
    }

    document.getElementById('providerNotes').classList.add('hidden');
    document.getElementById('accountFormMessage').classList.add('hidden');
  } catch (error) {
    console.error('Failed to load account for editing:', error);
    alert('Failed to load account details: ' + error.message);
  }
}

function cancelAccountForm() {
  document.getElementById('accountsList').classList.remove('hidden');
  document.getElementById('accountFormView').classList.add('hidden');
}

async function testAccountConnection() {
  const email = document.getElementById('accountEmail').value.trim();
  const password = document.getElementById('accountPassword').value;
  const imapHost = document.getElementById('accountImapHost').value.trim();
  const imapPort = document.getElementById('accountImapPort').value.trim();

  if (!email || !password || !imapHost || !imapPort) {
    showAccountFormMessage('Please fill in all fields', 'error');
    return;
  }

  showAccountFormMessage('Testing connection...', 'info');

  try {
    const response = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        password: password,
        host: imapHost,
        port: parseInt(imapPort),
        tls: true
      })
    });

    // Handle non-JSON responses (e.g., rate limiting, server errors)
    const contentType = response.headers.get('content-type');
    let result;
    if (contentType && contentType.includes('application/json')) {
      result = await response.json();
    } else {
      const text = await response.text();
      result = { success: false, error: text || 'Server returned non-JSON response' };
    }

    if (result.success) {
      showAccountFormMessage('✅ Connection successful!', 'success');
    } else {
      // Display both the error and helpful context
      let errorMessage = '❌ Connection failed: ' + result.error;
      if (result.help) {
        errorMessage += '\n\n' + result.help;
      }
      showAccountFormMessage(errorMessage, 'error');
    }
  } catch (error) {
    showAccountFormMessage('❌ Test failed: ' + error.message, 'error');
  }
}

async function saveAccount() {
  const email = document.getElementById('accountEmail').value.trim();
  const password = document.getElementById('accountPassword').value;
  const imapHost = document.getElementById('accountImapHost').value.trim();
  const imapPort = document.getElementById('accountImapPort').value.trim();

  // For edit mode, password is optional (only update if changed)
  const isEditMode = currentEditingAccountId !== null;
  if (!email || !imapHost || !imapPort) {
    showAccountFormMessage('Please fill in required fields', 'error');
    return;
  }

  if (!isEditMode && !password) {
    showAccountFormMessage('Password is required for new accounts', 'error');
    return;
  }

  showAccountFormMessage(isEditMode ? 'Updating account...' : 'Saving account...', 'info');

  try {
    const accountData = {
      email: email,
      host: imapHost,
      port: parseInt(imapPort),
      tls: true
    };

    // Only include password if provided (required for new, optional for edit)
    if (password) {
      accountData.password = password;
    }

    // Add SMTP configuration if enabled
    const smtpEnabled = document.getElementById('smtpEnabled').checked;
    if (smtpEnabled) {
      const smtpHost = document.getElementById('accountSmtpHost').value.trim();
      const smtpPort = document.getElementById('accountSmtpPort').value.trim();
      const smtpSecure = document.getElementById('accountSmtpSecure').checked;

      if (smtpHost && smtpPort) {
        accountData.smtp = {
          host: smtpHost,
          port: parseInt(smtpPort),
          secure: smtpSecure,
          user: email,
          password: password || undefined  // Use password if provided
        };
      }
    }

    const url = isEditMode ? `/api/accounts/${currentEditingAccountId}` : '/api/accounts';
    const method = isEditMode ? 'PUT' : 'POST';

    const response = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(accountData)
    });

    const result = await response.json();

    if (result.success) {
      showAccountFormMessage(isEditMode ? '✅ Account updated successfully!' : '✅ Account saved successfully!', 'success');
      setTimeout(() => {
        currentEditingAccountId = null;
        cancelAccountForm();
        loadAccountsList();
      }, 1500);
    } else {
      // Display both the error and helpful context
      let errorMessage = '❌ Failed to save: ' + result.error;
      if (result.help) {
        errorMessage += '\n\n' + result.help;
      }
      showAccountFormMessage(errorMessage, 'error');
    }
  } catch (error) {
    showAccountFormMessage('❌ Save failed: ' + error.message, 'error');
  }
}

function showAccountFormMessage(message, type) {
  const messageEl = document.getElementById('accountFormMessage');
  messageEl.classList.remove('hidden');

  const bgColors = {
    success: 'bg-green-50 border-green-200 text-green-800',
    error: 'bg-red-50 border-red-200 text-red-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800'
  };

  messageEl.className = `mt-4 p-4 rounded-md border ${bgColors[type] || bgColors.info}`;

  // Preserve line breaks in multi-line messages
  messageEl.style.whiteSpace = 'pre-line';
  messageEl.textContent = message;
}

async function connectAccount(accountId) {
  try {
    const response = await fetch(`/api/accounts/${accountId}/connect`, {
      method: 'POST'
    });

    const result = await response.json();

    if (result.success) {
      loadAccountsList();
    } else {
      alert('Failed to connect: ' + result.error);
    }
  } catch (error) {
    alert('Failed to connect: ' + error.message);
  }
}

async function deleteAccount(accountId) {
  if (!confirm('Are you sure you want to delete this account?')) return;

  try {
    const response = await fetch(`/api/accounts/${accountId}`, {
      method: 'DELETE'
    });

    const result = await response.json();

    if (result.success) {
      loadAccountsList();
    } else {
      alert('Failed to delete: ' + result.error);
    }
  } catch (error) {
    alert('Failed to delete: ' + error.message);
  }
}

async function testSingleAccount(accountId) {
  const resultDiv = document.getElementById(`test-result-${accountId}`);
  resultDiv.classList.remove('hidden');
  resultDiv.innerHTML = '<div class="text-gray-600">Testing connection...</div>';

  try {
    const response = await fetch(`/api/accounts/${accountId}/test`, {
      method: 'POST'
    });

    const result = await response.json();

    if (result.success && result.results) {
      const testResults = result.results;
      const imapStatus = testResults.imap?.success
        ? `<span class="text-green-600">✓ IMAP Connected</span>`
        : `<span class="text-red-600">✗ IMAP Failed</span>`;

      const smtpStatus = testResults.smtp?.tested
        ? (testResults.smtp.success ? `<span class="text-green-600">✓ SMTP OK</span>` : `<span class="text-red-600">✗ SMTP Failed</span>`)
        : `<span class="text-gray-500">○ SMTP Not Tested</span>`;

      // Build error details with help text
      let errorDetails = '';
      if (testResults.error) {
        errorDetails = `<div class="text-xs text-red-600 mt-2 whitespace-pre-line">${testResults.error}</div>`;
      }
      if (testResults.imap?.error) {
        errorDetails += `<div class="text-xs text-red-600 mt-2 whitespace-pre-line">IMAP: ${testResults.imap.error}</div>`;
      }
      if (testResults.smtp?.error) {
        errorDetails += `<div class="text-xs text-red-600 mt-2 whitespace-pre-line">SMTP: ${testResults.smtp.error}</div>`;
      }

      resultDiv.innerHTML = `
        <div class="bg-gray-50 rounded p-3">
          <div class="flex gap-4">
            <div>${imapStatus}</div>
            <div>${smtpStatus}</div>
          </div>
          ${testResults.imap?.unreadCount !== undefined ? `<div class="text-xs text-gray-600 mt-1">📬 ${testResults.imap.unreadCount} unread emails</div>` : ''}
          ${errorDetails}
          <div class="text-xs text-gray-500 mt-1">Test completed in ${testResults.totalTime}ms</div>
        </div>
      `;
    } else {
      // Display error with help text if available
      let errorMessage = result.error || 'Test failed';
      if (result.help) {
        errorMessage += '\n\n' + result.help;
      }
      resultDiv.innerHTML = `<div class="bg-red-50 text-red-600 rounded p-3 whitespace-pre-line">❌ ${errorMessage}</div>`;
    }
  } catch (error) {
    resultDiv.innerHTML = `<div class="bg-red-50 text-red-600 rounded p-3">❌ ${error.message}</div>`;
  }
}

async function checkAccountStatus() {
  try {
    const response = await fetch('/api/accounts/status');
    const result = await response.json();

    if (result.success && result.accounts) {
      // Create a status dialog/modal
      const statusHtml = `
        <div style="position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    background: white; padding: 24px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                    max-width: 600px; max-height: 80vh; overflow-y: auto; z-index: 1000;">
          <div style="display: flex; justify-between; align-items: center; margin-bottom: 16px;">
            <h3 style="font-size: 18px; font-weight: bold;">Account Login Status</h3>
            <button onclick="closeStatusDialog()" style="background: none; border: none; font-size: 24px; cursor: pointer;">&times;</button>
          </div>
          <div style="space-y: 12px;">
            ${result.accounts.map(acc => {
              let statusColor = 'gray';
              let statusText = 'Unknown';
              let statusIcon = '○';

              if (acc.status === 'connected') {
                statusColor = 'green';
                statusText = 'Connected';
                statusIcon = '✓';
              } else if (acc.status === 'circuit_breaker_open') {
                statusColor = 'red';
                statusText = 'Circuit Breaker Open';
                statusIcon = '✗';
              } else if (acc.status === 'recovering') {
                statusColor = 'orange';
                statusText = 'Recovering';
                statusIcon = '↻';
              } else if (acc.status === 'error') {
                statusColor = 'red';
                statusText = 'Error';
                statusIcon = '✗';
              } else {
                statusColor = 'gray';
                statusText = 'Disconnected';
                statusIcon = '○';
              }

              return `
                <div style="border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; margin-bottom: 12px;">
                  <div style="font-weight: 600; margin-bottom: 4px;">${acc.email}</div>
                  <div style="font-size: 14px; color: #666; margin-bottom: 4px;">${acc.host}</div>
                  <div style="font-size: 14px; color: ${statusColor}; font-weight: 500;">
                    ${statusIcon} ${statusText}
                  </div>
                  ${acc.error ? `<div style="font-size: 13px; color: #dc2626; margin-top: 8px; padding: 8px; background: #fef2f2; border-radius: 4px;">${acc.error}</div>` : ''}
                </div>
              `;
            }).join('')}
          </div>
        </div>
        <div id="statusDialogBackdrop" onclick="closeStatusDialog()"
             style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 999;"></div>
      `;

      const dialogDiv = document.createElement('div');
      dialogDiv.id = 'statusDialog';
      dialogDiv.innerHTML = statusHtml;
      document.body.appendChild(dialogDiv);
    } else {
      alert('Failed to check account status: ' + (result.error || 'Unknown error'));
    }
  } catch (error) {
    alert('Failed to check account status: ' + error.message);
  }
}

function closeStatusDialog() {
  const dialog = document.getElementById('statusDialog');
  if (dialog) {
    dialog.remove();
  }
}

async function testAllAccounts() {
  try {
    const response = await fetch('/api/accounts');
    const accounts = await response.json();

    if (!Array.isArray(accounts) || accounts.length === 0) {
      alert('No accounts to test');
      return;
    }

    // Test each account
    for (const account of accounts) {
      await testSingleAccount(account.id);
    }
  } catch (error) {
    alert('Failed to test accounts: ' + error.message);
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  showDashboard();
});
