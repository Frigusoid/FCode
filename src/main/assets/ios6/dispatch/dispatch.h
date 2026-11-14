/*
 * Последовательная замена libdispatch для сборки ld64 (см. setup.sh).
 *
 * В Ubuntu 25.10 пакета libdispatch нет, а cctools-port без него не
 * конфигурируется. Линкеру dispatch нужен только для параллельности:
 * выполняем блоки по очереди — на результат это не влияет.
 */

#ifndef FCODE_DISPATCH_STUB_H
#define FCODE_DISPATCH_STUB_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DISPATCH_QUEUE_SERIAL ((void *)0)
#define DISPATCH_APPLY_AUTO ((void *)0)
#define DISPATCH_QUEUE_PRIORITY_HIGH 2
#define DISPATCH_TIME_FOREVER (~0ull)

typedef void *dispatch_queue_t;
typedef void *dispatch_group_t;
typedef void *dispatch_queue_global_t;
typedef void *dispatch_object_t;
typedef long dispatch_once_t;
typedef void (^dispatch_block_t)(void);
typedef void (^dispatch_apply_t)(size_t);

dispatch_queue_t dispatch_get_global_queue(long identifier, unsigned long flags);
dispatch_queue_t dispatch_queue_create(const char *label, void *attr);
void dispatch_release(dispatch_object_t object);
void dispatch_retain(dispatch_object_t object);

void dispatch_sync(dispatch_queue_t queue, dispatch_block_t block);
void dispatch_async(dispatch_queue_t queue, dispatch_block_t block);
void dispatch_apply(size_t iterations, dispatch_queue_t queue, dispatch_apply_t block);
void dispatch_once(dispatch_once_t *predicate, dispatch_block_t block);

dispatch_group_t dispatch_group_create(void);
void dispatch_group_async(dispatch_group_t group, dispatch_queue_t queue, dispatch_block_t block);
long dispatch_group_wait(dispatch_group_t group, uint64_t timeout);

uint64_t dispatch_qaddr(dispatch_queue_t queue);

#ifdef __cplusplus
}
#endif

#endif
