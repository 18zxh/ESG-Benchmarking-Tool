"""Public, non-sensitive API errors."""


class RequestError(Exception):
    def __init__(self, message, category="validation", status=422):
        super().__init__(message)
        self.category = category
        self.status = status

    def response(self):
        return {"error": {"category": self.category, "message": str(self)}}
