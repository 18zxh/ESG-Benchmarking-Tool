"""One cooperative task state machine for page ranges and evidence groups."""
import copy
import threading
import uuid
from pipeline.errors import RequestError
from pipeline.model_proxy import empty_usage


class Stopped(Exception):
    pass


class Task:
    def __init__(self, mode):
        self.condition = threading.Condition(threading.RLock())
        self.thread = None
        self.data = {"id": uuid.uuid4().hex, "mode": mode, "status": "pending", "phase": "pending",
                     "processedPages": 0, "totalPages": 0, "progress": 0, "completedPieces": 0,
                     "results": {}, "errors": [], "usage": empty_usage()}

    def snapshot(self):
        with self.condition:
            return copy.deepcopy(self.data)

    def checkpoint(self):
        with self.condition:
            while self.data["status"] == "paused":
                self.condition.wait()
            if self.data["status"] == "stopped":
                raise Stopped

    def update(self, **values):
        with self.condition:
            self.data.update(values)

    def result(self, topic_id, value):
        with self.condition:
            self.data['results'][topic_id] = value

    def error(self, value):
        with self.condition:
            self.data['errors'].append(value)

    def control(self, action):
        with self.condition:
            state = self.data["status"]
            if action == "pause" and state in ("pending", "in_progress"):
                self.data["status"] = "paused"
            elif action == "resume" and state == "paused":
                self.data["status"] = "in_progress"
            elif action == "stop" and state in ("pending", "in_progress", "paused"):
                self.data["status"] = "stopped"
            else:
                raise RequestError("当前任务状态不支持此操作。", "job_state", 409)
            self.condition.notify_all()
        return self.snapshot()

    def start(self, worker, asynchronous=True):
        def run():
            self.update(status="in_progress", runId=uuid.uuid4().hex)
            try:
                worker(self)
                self.checkpoint()
                self.update(status="completed", progress=100)
            except Stopped:
                pass
            except RequestError as exc:
                self.update(status="failed", error=exc.response()["error"])
            except Exception:
                self.update(status="failed", error={"category": "internal", "message": "任务未完成；已成功结果保留，可重试。"})
        if asynchronous:
            self.thread = threading.Thread(target=run, name="workbench-task", daemon=True)
            self.thread.start()
        else:
            run()
        return self.snapshot()


class TaskRegistry:
    def __init__(self):
        self.tasks = {}
        self.lock = threading.RLock()

    def add(self, task):
        with self.lock:
            self.tasks[task.data["id"]] = task
        return task

    def get(self, task_id):
        with self.lock:
            task = self.tasks.get(task_id)
        if task is None:
            raise RequestError("任务不存在，请重新开始；已保存结果保留。", "job_missing", 404)
        return task
