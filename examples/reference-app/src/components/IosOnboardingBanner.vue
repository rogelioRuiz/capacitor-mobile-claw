<template>
  <div v-if="show" class="ios-onboarding-banner">
    <div class="banner-content">
      <span class="banner-icon">📱</span>
      <div class="banner-text">
        <strong>Training iOS Background Tasks</strong>
        <p>
          Open the app daily to help iOS learn your usage pattern.
          Day {{ dayCount }}/7 — {{ daysLeft }} days left.
        </p>
      </div>
      <button class="banner-dismiss" @click="$emit('dismiss')">&times;</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  show: { type: Boolean, default: false },
  enabledAt: { type: Number, default: null },
})

defineEmits(['dismiss'])

const dayCount = computed(() => {
  const start = props.enabledAt || Number(localStorage.getItem('sentinel-enabled-at') || Date.now())
  const days = Math.floor((Date.now() - start) / (24 * 60 * 60 * 1000)) + 1
  return Math.max(1, Math.min(7, days))
})

const daysLeft = computed(() => Math.max(0, 7 - dayCount.value))
</script>

<style scoped>
.ios-onboarding-banner {
  margin: 0.5rem 0.75rem 0.75rem;
  border: 1px solid rgba(59, 130, 246, 0.35);
  background: linear-gradient(120deg, rgba(37, 99, 235, 0.18), rgba(29, 78, 216, 0.08));
  border-radius: 0.75rem;
  overflow: hidden;
}

.banner-content {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  padding: 0.75rem;
}

.banner-icon {
  line-height: 1;
  font-size: 1.1rem;
}

.banner-text {
  flex: 1;
  min-width: 0;
}

.banner-text strong {
  display: block;
  font-size: 0.8rem;
  color: var(--color-foreground);
}

.banner-text p {
  margin-top: 0.2rem;
  font-size: 0.72rem;
  color: color-mix(in srgb, var(--color-foreground) 75%, transparent);
  line-height: 1.35;
}

.banner-dismiss {
  width: 1.4rem;
  height: 1.4rem;
  border-radius: 999px;
  border: none;
  background: rgba(255, 255, 255, 0.14);
  color: var(--color-foreground);
  cursor: pointer;
}
</style>
