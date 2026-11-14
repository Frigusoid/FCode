/*
 * Последовательная реализация dispatch для сборки ld64.
 * Все «асинхронные» вызовы выполняются сразу и синхронно.
 */

#include "dispatch/dispatch.h"

#include <stdlib.h>

static int stub_queue_slot = 0;

dispatch_queue_t dispatch_get_global_queue(long identifier, unsigned long flags) {
  (void)identifier;
  (void)flags;
  return (dispatch_queue_t)&stub_queue_slot;
}

dispatch_queue_t dispatch_queue_create(const char *label, void *attr) {
  (void)label;
  (void)attr;
  return (dispatch_queue_t)&stub_queue_slot;
}

void dispatch_release(dispatch_object_t object) { (void)object; }
void dispatch_retain(dispatch_object_t object) { (void)object; }

void dispatch_sync(dispatch_queue_t queue, dispatch_block_t block) {
  (void)queue;
  if (block) block();
}

void dispatch_async(dispatch_queue_t queue, dispatch_block_t block) {
  (void)queue;
  if (block) block();
}

void dispatch_apply(size_t iterations, dispatch_queue_t queue, dispatch_apply_t block) {
  (void)queue;
  if (!block) return;
  for (size_t index = 0; index < iterations; index += 1) block(index);
}

void dispatch_once(dispatch_once_t *predicate, dispatch_block_t block) {
  if (!predicate) return;
  if (*predicate == 0) {
    *predicate = 1;
    if (block) block();
  }
}

typedef struct {
  int pending;
} stub_group;

dispatch_group_t dispatch_group_create(void) {
  return (dispatch_group_t)calloc(1, sizeof(stub_group));
}

void dispatch_group_async(dispatch_group_t group, dispatch_queue_t queue, dispatch_block_t block) {
  (void)queue;
  if (group) ((stub_group *)group)->pending += 1;
  if (block) block();
  if (group) ((stub_group *)group)->pending -= 1;
}

long dispatch_group_wait(dispatch_group_t group, uint64_t timeout) {
  (void)timeout;
  if (!group) return 0;
  return ((stub_group *)group)->pending == 0 ? 0 : 1;
}

uint64_t dispatch_qaddr(dispatch_queue_t queue) { return (uint64_t)(uintptr_t)queue; }
