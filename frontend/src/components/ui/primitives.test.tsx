import * as React from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { Badge } from "./badge"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible"
import { Progress } from "./progress"
import { ScrollArea } from "./scroll-area"
import { Separator } from "./separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"
import { Textarea } from "./textarea"
import { Toaster } from "./toaster"
import { ToggleGroup, ToggleGroupItem } from "./toggle-group"
import { toast } from "./use-toast"

// jsdom does not implement ResizeObserver, which Radix ScrollArea uses to
// measure its viewport and scrollbars. A no-op shim is enough for render tests.
if (!("ResizeObserver" in globalThis)) {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
}

test("card renders its children", () => {
  render(
    <Card>
      <CardHeader>
        <CardTitle>翻译服务</CardTitle>
        <CardDescription>在线 API 与本地模型</CardDescription>
      </CardHeader>
      <CardContent>服务正文</CardContent>
      <CardFooter>底部操作</CardFooter>
    </Card>
  )

  expect(screen.getByText("翻译服务")).toBeInTheDocument()
  expect(screen.getByText("服务正文")).toBeInTheDocument()
})

test("textarea accepts a default value and placeholder", () => {
  render(<Textarea defaultValue="自定义提示词" placeholder="请输入提示词" />)

  const textarea = screen.getByPlaceholderText("请输入提示词")
  expect(textarea).toHaveValue("自定义提示词")
})

test("tabs switches the visible panel when a trigger is activated", () => {
  render(
    <Tabs defaultValue="text">
      <TabsList>
        <TabsTrigger value="text">文字</TabsTrigger>
        <TabsTrigger value="image">图片</TabsTrigger>
      </TabsList>
      <TabsContent value="text">文字技能列表</TabsContent>
      <TabsContent value="image">图片技能列表</TabsContent>
    </Tabs>
  )

  expect(screen.getByRole("tabpanel")).toHaveTextContent("文字技能列表")

  fireEvent.mouseDown(screen.getByRole("tab", { name: "图片" }), { button: 0 })

  expect(screen.getByRole("tabpanel")).toHaveTextContent("图片技能列表")
})

test("scroll area renders its children", () => {
  render(
    <ScrollArea className="h-24">
      <p>可滚动内容</p>
    </ScrollArea>
  )

  expect(screen.getByText("可滚动内容")).toBeInTheDocument()
})

test("separator exposes separator role and orientation", () => {
  render(<Separator decorative={false} orientation="vertical" />)

  expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "vertical")
})

test("badge renders its label with the variant styling", () => {
  render(<Badge variant="secondary">已连接</Badge>)

  expect(screen.getByText("已连接").className).toContain("bg-secondary")
})

test("progress exposes its value and translates the indicator", () => {
  render(<Progress value={40} />)

  const progress = screen.getByRole("progressbar")
  expect(progress).toHaveAttribute("aria-valuenow", "40")
  expect((progress.firstElementChild as HTMLElement).style.transform).toBe("translateX(-60%)")
})

test("toggle group item reports its checked state when toggled", () => {
  render(
    <ToggleGroup type="single" aria-label="面板模式">
      <ToggleGroupItem value="scroll">滚动</ToggleGroupItem>
      <ToggleGroupItem value="auto">自适应</ToggleGroupItem>
    </ToggleGroup>
  )

  const item = screen.getByRole("radio", { name: "滚动" })
  expect(item).toHaveAttribute("aria-checked", "false")

  fireEvent.click(item)

  expect(item).toHaveAttribute("aria-checked", "true")
})

test("collapsible reveals content after the trigger is clicked", async () => {
  render(
    <Collapsible>
      <CollapsibleTrigger>展开提示词</CollapsibleTrigger>
      <CollapsibleContent>提示词正文</CollapsibleContent>
    </Collapsible>
  )

  expect(screen.queryByText("提示词正文")).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "展开提示词" }))

  expect(await screen.findByText("提示词正文")).toBeInTheDocument()
})

test("toast() stores a toast that the Toaster renders", async () => {
  render(<Toaster />)

  expect(screen.queryByText("已保存")).not.toBeInTheDocument()

  act(() => {
    toast({ title: "已保存", description: "设置已写入" })
  })

  expect(await screen.findByText("已保存")).toBeInTheDocument()
  expect(screen.getByText("设置已写入")).toBeInTheDocument()
})
