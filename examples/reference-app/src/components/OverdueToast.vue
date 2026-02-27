<template>
  <Transition name="slide-down">
    <div v-if="count > 0" class="overdue-toast">
      <span class="pulse-dot" />
      Running {{ count }} overdue scheduled task{{ count > 1 ? 's' : '' }}...
    </div>
  </Transition>
</template>

<script setup>
defineProps({
  count: { type: Number, default: 0 },
})
</script>

<style scoped>
.overdue-toast {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + 0.5rem);
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.8rem;
  border-radius: 999px;
  border: 1px solid rgba(245, 158, 11, 0.4);
  background: rgba(17, 24, 39, 0.94);
  color: #fcd34d;
  font-size: 0.76rem;
  letter-spacing: 0.01em;
}

.pulse-dot {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 999px;
  background: #f59e0b;
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.45;
    transform: scale(0.9);
  }
  50% {
    opacity: 1;
    transform: scale(1.1);
  }
}

.slide-down-enter-active,
.slide-down-leave-active {
  transition: all 0.2s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px);
}
</style>
