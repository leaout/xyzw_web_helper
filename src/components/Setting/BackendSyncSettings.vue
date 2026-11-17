<template>
  <a-card>
    <template #title>
      <span>后端定时任务同步</span>
    </template>
    <template #extra>
      <a-switch v-model="cfg.enabled" @change="onToggle" />
    </template>

    <a-alert type="info" style="margin-bottom: 16px">
      配置常驻后端后，导入的角色 Token 会自动同步过去，即使关闭浏览器，
      后端也能按定时任务继续执行。未开启时不影响任何现有功能。
    </a-alert>

    <a-form :model="cfg" label-placement="left" label-width="100px">
      <a-form-item label="后端地址">
        <a-input
          v-model="cfg.baseUrl"
          placeholder="https://xyzw-backend.onrender.com"
          :disabled="!cfg.enabled"
          allow-clear
        />
        <template #help>Render 部署后给你的服务地址，末尾不要带斜杠</template>
      </a-form-item>

      <a-form-item label="API 密钥">
        <a-input-password
          v-model="cfg.apiKey"
          placeholder="与后端环境变量 API_KEY 一致"
          :disabled="!cfg.enabled"
          allow-clear
        />
      </a-form-item>
    </a-form>

    <a-space>
      <a-button type="primary" :loading="testing" :disabled="!cfg.enabled" @click="onTest">
        测试连接
      </a-button>
      <a-button :loading="pushing" :disabled="!cfg.enabled" @click="onPushAll">
        同步全部 Token
      </a-button>
      <a-button status="danger" @click="onReset">清除配置</a-button>
    </a-space>

    <div v-if="tip" class="sync-tip">{{ tip }}</div>
  </a-card>
</template>

<script setup>
import { onMounted, reactive, ref } from "vue";
import { Message } from "@arco-design/web-vue";
import { useTokenStore } from "@/stores/tokenStore";
import {
  getBackendSyncConfig,
  setBackendSyncConfig,
  testBackendConnection,
} from "@/utils/backendSync";

const cfg = reactive({ enabled: false, baseUrl: "", apiKey: "" });
const testing = ref(false);
const pushing = ref(false);
const tip = ref("");
const tokenStore = useTokenStore();

onMounted(() => {
  Object.assign(cfg, getBackendSyncConfig());
});

function persist() {
  setBackendSyncConfig({ ...cfg });
}

function onToggle(val) {
  persist();
  Message.info(val ? "后端同步已开启，记得填写地址并测试连接" : "后端同步已关闭");
}

async function onTest() {
  persist();
  testing.value = true;
  tip.value = "";
  const result = await testBackendConnection();
  testing.value = false;
  if (result.ok) {
    tip.value = `连接成功：当前后端有 ${result.data?.activeCrons ?? 0} 个定时任务`;
    Message.success("后端连接正常");
  } else {
    tip.value = `连接失败：${result.error}`;
    Message.error("无法连接后端");
  }
}

async function onPushAll() {
  persist();
  pushing.value = true;
  const result = await tokenStore.syncAllTokensToBackend();
  pushing.value = false;
  if (result) {
    Message.success(`已同步 ${result.count ?? 0} 个 Token 到后端`);
  } else {
    Message.warning("同步未执行：请检查是否已开启并填写正确地址");
  }
}

function onReset() {
  Object.assign(cfg, { enabled: false, baseUrl: "", apiKey: "" });
  persist();
  tip.value = "";
  Message.success("配置已清除");
}
</script>

<style scoped>
.sync-tip {
  margin-top: 12px;
  font-size: 13px;
  color: var(--color-text-2, #86909c);
}
</style>
